// Two computers serving the same public address at once find each other, and the one that took over more recently
// steps back. Cloudflare Tunnel happily runs two connectors for one address and splits requests between them, so
// nothing else stops it. A stub tunnel, a round-robin "public address" on loopback, temp folders and fake values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-cluster-secret-0123456789abcdef';
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CANVAS|NGROK)/i.test(k)));
// Stands in for cloudflared: answers /ready on the metrics port, as cloudflared does once it reaches Cloudflare.
const STUB = "const http=require('http');const i=process.argv.indexOf('--metrics');const [h,p]=process.argv[i+1].split(':');http.createServer((q,s)=>{s.statusCode=q.url==='/ready'?200:404;s.end('{}')}).listen(Number(p),h);";

/**
 * A public address in front of both computers, like Cloudflare with two connectors. Cloudflare sends each visitor to a
 * connector near them, so one computer can get every request: `prefer` says which ('older' or 'newer').
 */
async function publicAddress(prefer) {
  const backends = [];
  let online = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!online) { res.writeHead(502); res.end(); return; }
      const order = prefer === 'newer' ? [...backends].reverse() : [...backends];
      const attempt = (i) => {
        if (i >= order.length) { res.writeHead(502); res.end(); return; }
        const up = http.request({ host: '127.0.0.1', port: order[i], path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
        up.on('error', () => attempt(i + 1));
        up.end(Buffer.concat(chunks));
      };
      attempt(0);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, backends, goOnline: () => { online = true; }, close: () => server.close() };
}

async function supervisor(label, pub, { stub = STUB } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `canvas-failover-${label}-`));
  fs.writeFileSync(path.join(cwd, 'tunnel.js'), stub);
  const port = await freePort();
  pub.backends.push(port);
  const child = spawn(process.execPath, [path.join(ROOT, 'supervisor.js')], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...cleanEnv(), CANVAS_MCP_TUNNEL: 'cloudflared', CANVAS_MCP_CLOUDFLARED_PATH: process.execPath, CANVAS_MCP_CLOUDFLARED_TOKEN: 'fake-tunnel-token',
      CANVAS_MCP_CLOUDFLARED_METRICS_PORT: String(await freePort()), CANVAS_MCP_PUBLIC_URL: pub.url, CANVAS_MCP_CLUSTER_SECRET: SECRET,
      CANVAS_MCP_PASSWORD: 'a-long-test-password', CANVAS_MCP_PORT: String(port), CANVAS_API_TOKEN: 'fake-token', CANVAS_BASE_URL: 'http://127.0.0.1:9',
      CANVAS_MCP_FAILOVER_SECONDS: '10',
    },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'supervisor-state.json'), 'utf8')).state; } catch { return null; } };
  const stop = async () => {
    fs.writeFileSync(path.join(cwd, 'stop.flag'), 'x');
    const gone = new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
    await Promise.race([gone, sleep(8000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  };
  return { label, cwd, child, state, log: () => log, stop };
}

test('the tunnel program gets its own token and none of the server\'s secrets', { timeout: 60000 }, async () => {
  // Writes down the names of the settings it was started with (never their values), then acts like cloudflared.
  const stub = `require('fs').writeFileSync('tunnel-env.json', JSON.stringify(Object.keys(process.env)));${STUB}`;
  const pub = await publicAddress();
  const one = await supervisor('env', pub, { stub });
  try {
    const until = Date.now() + 30000;
    while (Date.now() < until && !fs.existsSync(path.join(one.cwd, 'tunnel-env.json'))) await sleep(300);
    const names = JSON.parse(fs.readFileSync(path.join(one.cwd, 'tunnel-env.json'), 'utf8'));
    assert.ok(names.includes('TUNNEL_TOKEN'), 'cloudflared gets its tunnel token');
    assert.deepEqual(names.filter((n) => /^CANVAS_/i.test(n)), [], 'and none of the CANVAS_ settings: the token, the password, the cluster secret');
    assert.ok(names.some((n) => /^path$/i.test(n)), 'the rest of the environment is still there');
  } finally {
    await one.stop();
    pub.close();
  }
});

async function settles(prefer) {
  const pub = await publicAddress(prefer);
  const first = await supervisor('first', pub);
  await sleep(1500);
  const second = await supervisor('second', pub);
  try {
    // Neither can see the other at first, as if the second one had lost its connection and taken over.
    const bothUp = Date.now() + 30000;
    while (Date.now() < bothUp && !(first.log().includes('active and serving') && second.log().includes('active and serving'))) await sleep(300);
    assert.ok(first.log().includes('active and serving') && second.log().includes('active and serving'), `both should start serving\n${first.log()}\n${second.log()}`);
    pub.goOnline();

    const settle = Date.now() + 45000;
    while (Date.now() < settle && !(first.state() === 'active' && second.state() === 'standby')) await sleep(500);
    assert.equal(first.state(), 'active', `${first.log()}\n---\n${second.log()}`);
    assert.equal(second.state(), 'standby', second.log());
    assert.match(second.log() + first.log(), /also serving the public address/);

    await sleep(12000); // longer than the failover window: it stays settled, with no flapping back and forth
    assert.equal(first.state(), 'active');
    assert.equal(second.state(), 'standby');
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    pub.close();
  }
}

test('two computers serving at once settle on the one that was serving first, when requests reach the newer one', { timeout: 120000 }, () => settles('newer'));
test('the same when requests reach the older one', { timeout: 120000 }, () => settles('older'));

test('a step-down meant for another computer is refused', { timeout: 30000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-stepdown-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cleanEnv(), CANVAS_API_TOKEN: 'fake-token', CANVAS_BASE_URL: 'http://127.0.0.1:9', CANVAS_MCP_PORT: String(port), CANVAS_MCP_CLUSTER_SECRET: SECRET },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const ready = Date.now() + 15000;
    while (Date.now() < ready && !/ready on http/.test(out)) await sleep(200);
    const ask = (body) => fetch(`http://127.0.0.1:${port}/internal/step-down`, { method: 'POST', headers: { 'X-Cluster-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const other = await ask({ hostname: os.hostname(), pid: child.pid + 1 });
    assert.equal(other.status, 409);
    await sleep(800);
    assert.equal(child.exitCode, null, 'it keeps serving');
    const mine = await ask({ hostname: os.hostname(), pid: child.pid });
    assert.equal(mine.status, 200);
    const code = await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r(child.exitCode)));
    assert.equal(code, 42, 'the one it was meant for steps down');
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
