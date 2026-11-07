// What must never happen on the Remote server: starting up open to the internet, unlimited guessing at the cluster
// secret, and a stranger's text running on the status page. Random ports and temp folders; no network, no real token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupProblems } from '../startup-check.js';
import { dashboardPage } from '../status-page.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = 'https://demo.example.dev';
const GOOD = { CANVAS_MCP_PUBLIC_URL: PUBLIC, CANVAS_MCP_PASSWORD: 'a-long-test-password', CANVAS_MCP_CLUSTER_SECRET: 'x'.repeat(43) };

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CANVAS|NGROK)/i.test(k)));
const keys = (env) => startupProblems(env).errors.map((e) => e.key);

/** Start a script from a temp folder and wait until it says it's ready, or until it exits. */
async function start(script, env, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-remote-sec-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cleanEnv(), CANVAS_API_TOKEN: 'test-token', CANVAS_BASE_URL: 'https://canvas.example.edu', CANVAS_MCP_PORT: String(port), ...env },
  });
  let output = '';
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 15000);
    const on = (d) => { output += d; if (/ready on (http|stdio)/.test(output)) { clearTimeout(timer); resolve({ ready: true }); } };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code }); });
  });
  const stop = async () => {
    if (child.exitCode === null) { const gone = new Promise((r) => child.once('exit', r)); child.kill(); await gone; }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { ...result, port, output: () => output, stop };
}

// ---------------------------------------------------------------------------------------------------------------
// Starting up
// ---------------------------------------------------------------------------------------------------------------

test('a server open to the internet needs a real password', () => {
  assert.deepEqual(keys({ CANVAS_MCP_PUBLIC_URL: PUBLIC }), ['CANVAS_MCP_PASSWORD']);
  assert.deepEqual(keys({ ...GOOD, CANVAS_MCP_PASSWORD: '' }), ['CANVAS_MCP_PASSWORD']);
  assert.deepEqual(keys({ ...GOOD, CANVAS_MCP_PASSWORD: '   ' }), ['CANVAS_MCP_PASSWORD']);
  assert.deepEqual(keys({ ...GOOD, CANVAS_MCP_PASSWORD: 'choose_a_long_random_password' }), ['CANVAS_MCP_PASSWORD']);
});

test('a placeholder or short cluster secret is refused', () => {
  assert.deepEqual(keys({ ...GOOD, CANVAS_MCP_CLUSTER_SECRET: 'generate_a_long_random_secret' }), ['CANVAS_MCP_CLUSTER_SECRET']);
  assert.deepEqual(keys({ ...GOOD, CANVAS_MCP_CLUSTER_SECRET: 'short' }), ['CANVAS_MCP_CLUSTER_SECRET']);
  assert.deepEqual(keys({ CANVAS_MCP_CLUSTER_SECRET: 'short' }), ['CANVAS_MCP_CLUSTER_SECRET'], 'a weak secret is weak on any computer');
});

test('listening beyond this computer needs a public address, or sign-in never turns on', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.20']) {
    assert.deepEqual(keys({ CANVAS_MCP_HOST: host }), ['CANVAS_MCP_PUBLIC_URL'], host);
    assert.deepEqual(keys({ CANVAS_MCP_HOST: host, CANVAS_MCP_PASSWORD: 'a-long-test-password' }), ['CANVAS_MCP_PUBLIC_URL'], host);
    assert.deepEqual(keys({ ...GOOD, CANVAS_MCP_HOST: host }), [], `${host} with a public address and password is fine`);
  }
});

test('a short password warns for now instead of taking a working server offline', () => {
  const r = startupProblems({ ...GOOD, CANVAS_MCP_PASSWORD: 'short-pass' });
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join(' '), /12 or more/);
});

test('a restrictive setting nobody can read stops the server', () => {
  assert.deepEqual(keys({ ...GOOD, CANVAS_ALLOW_WRITES: 'flase' }), ['settings']);
  assert.deepEqual(keys({ ...GOOD, CANVAS_PROFILE: 'cor' }), ['settings']);
});

test('the setups people really have keep working', () => {
  assert.deepEqual(startupProblems({}), { errors: [], warnings: [] }, 'this computer only, no tunnel');
  assert.deepEqual(startupProblems({ CANVAS_MCP_HOST: 'localhost' }), { errors: [], warnings: [] });
  assert.deepEqual(startupProblems(GOOD), { errors: [], warnings: [] }, 'what the setup app writes');
  assert.deepEqual(startupProblems({ ...GOOD, CANVAS_ALLOW_WRITES: 'False', CANVAS_PROFILE: 'Core ' }), { errors: [], warnings: [] });
});

test('the HTTP server refuses to start open, and says why', { timeout: 60000 }, async () => {
  const cases = [
    [{ CANVAS_MCP_PUBLIC_URL: PUBLIC }, /CANVAS_MCP_PASSWORD/],
    [{ ...GOOD, CANVAS_MCP_PASSWORD: 'choose_a_long_random_password' }, /CANVAS_MCP_PASSWORD/],
    [{ ...GOOD, CANVAS_MCP_CLUSTER_SECRET: 'generate_a_long_random_secret' }, /CANVAS_MCP_CLUSTER_SECRET/],
    [{ CANVAS_MCP_HOST: '127.0.0.2' }, /CANVAS_MCP_PUBLIC_URL/],
    [{ ...GOOD, CANVAS_ALLOW_WRITES: 'flase' }, /CANVAS_ALLOW_WRITES/],
  ];
  for (const [env, message] of cases) {
    const s = await start('index.js', env);
    assert.equal(s.code, 1, `must exit: ${JSON.stringify(env)} ${s.output()}`);
    assert.match(s.output(), message);
    await s.stop();
  }
});

test('the supervisor refuses too, so it never restarts a server that cannot start', { timeout: 30000 }, async () => {
  const s = await start('supervisor.js', { CANVAS_MCP_PUBLIC_URL: 'http://127.0.0.1:9', CANVAS_MCP_CLUSTER_SECRET: 'x'.repeat(43), CANVAS_MCP_TUNNEL: 'none' });
  assert.equal(s.code, 1, s.output());
  assert.match(s.output(), /CANVAS_MCP_PASSWORD/);
  await s.stop();
});

test('stdio mode still starts without a password, for directory checks', { timeout: 30000 }, async () => {
  const s = await start('index.js', { CANVAS_MCP_PUBLIC_URL: PUBLIC, CANVAS_MCP_TRANSPORT: 'stdio' });
  assert.equal(s.ready, true, s.output());
  await s.stop();
});

test('the startup check ships in the npm package', () => {
  const { files } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(files.includes('startup-check.js'));
});

test('a normal server still starts', { timeout: 30000 }, async () => {
  const s = await start('index.js', GOOD);
  assert.equal(s.ready, true, s.output());
  await s.stop();
});

// ---------------------------------------------------------------------------------------------------------------
// The running server
// ---------------------------------------------------------------------------------------------------------------

test('guessing the cluster secret gets locked out, and the real computers are not', { timeout: 30000 }, async () => {
  const s = await start('index.js', GOOD);
  try {
    assert.equal(s.ready, true, s.output());
    const url = `http://127.0.0.1:${s.port}/internal/whoami`;
    const guess = (secret, ip) => fetch(url, { headers: { 'X-Cluster-Secret': secret, 'X-Forwarded-For': ip } }).then((r) => r.status);
    for (let i = 0; i < 40; i++) assert.equal(await guess(GOOD.CANVAS_MCP_CLUSTER_SECRET, '10.9.0.1'), 200, 'good requests never count');
    const seen = [];
    for (let i = 0; i < 25; i++) seen.push(await guess(`guess-${i}`, '10.9.0.2'));
    assert.equal(seen[0], 403);
    assert.equal(seen.at(-1), 429, `expected a lockout, got ${seen.join(' ')}`);
    assert.equal(await guess(GOOD.CANVAS_MCP_CLUSTER_SECRET, '10.9.0.1'), 200, 'another address is not affected');
  } finally {
    await s.stop();
  }
});
