// Lost connections: what is retried, what must never be, and what the error and the log say afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CanvasClient, fetchWithRetry, hideAddresses, neverSent, networkError } from '../../core/canvas-client.js';
import { readConfig } from '../../core/config.js';
import { applyNetworkSettings, checkConnections, patientLookup, reportConnections } from '../../core/network.js';
import { createShared } from '../../core/shared.js';
import { connect } from './fake-canvas.js';

const failure = (code, more = {}) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`${code} happened`), { code, ...more }) });
const client = (fetchImpl) => new CanvasClient({ api: 'https://s.example.edu/api/v1', token: 't', ttl: 0, base: 'https://s.example.edu', fetchImpl });
const STORAGE = 'https://files.example.net/up?sig=SIGNED-SECRET';
const textOf = (res) => res.content[0].text;

/** A file to upload, plus an override that answers the upload handshake up to `storage`. */
function upload(storage, more = () => undefined) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-upload-')), 'essay.txt');
  fs.writeFileSync(file, 'hello');
  const override = (method, p, u) => {
    if (u.hostname === 'files.example.net') return storage;
    if (method === 'POST' && p.endsWith('/files')) return { body: { upload_url: STORAGE, upload_params: {} } };
    return more(method, p);
  };
  return { file, override };
}

test('only a connection that never opened counts as never sent', () => {
  for (const e of [failure('UND_ERR_CONNECT_TIMEOUT'), failure('ENOTFOUND'), failure('EAI_AGAIN'), failure('ECONNREFUSED'), failure('ETIMEDOUT', { syscall: 'connect' })]) {
    assert.equal(neverSent(e), true, e.cause.code);
  }
  const everyAddress = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([failure('ETIMEDOUT', { syscall: 'connect' }).cause, failure('ENETUNREACH', { syscall: 'connect' }).cause]), { code: 'ETIMEDOUT' }) });
  assert.equal(neverSent(everyAddress), true, 'every address failing to connect');
  for (const e of [failure('ECONNRESET'), failure('UND_ERR_SOCKET'), failure('ETIMEDOUT'), new TypeError('fetch failed'), new DOMException('slow', 'TimeoutError')]) {
    assert.equal(neverSent(e), false, 'it may have reached Canvas');
  }
});

test('a POST is repeated when the connection never opened, and never after one that dropped', async () => {
  let opened = 0;
  const c = client(async () => { if (++opened < 3) throw failure('UND_ERR_CONNECT_TIMEOUT'); return new Response('{"id":"1"}'); });
  assert.deepEqual(await c.post('/x', {}), { id: '1' });
  assert.equal(opened, 3);

  let sent = 0;
  const once = client(async () => { sent++; throw failure('ECONNRESET'); });
  await assert.rejects(once.post('/x', {}), /ECONNRESET/);
  assert.equal(sent, 1, 'it may already have gone through, so it must not go twice');
});

test('a repeatable POST survives any network failure', async () => {
  let n = 0;
  const c = client(async () => { if (++n < 2) throw failure('ECONNRESET'); return new Response('{"upload_url":"x"}'); });
  assert.deepEqual(await c.post('/slot', {}, undefined, { repeatable: true }), { upload_url: 'x' });
  assert.equal(n, 2);
});

test('network errors name the host and the code, and only blame the school address for the school', () => {
  const school = networkError(failure('UND_ERR_CONNECT_TIMEOUT'), { url: 'https://s.example.edu/api/v1/x', base: 'https://s.example.edu', attempts: 4 });
  assert.match(school.message, /Canvas at s\.example\.edu \(UND_ERR_CONNECT_TIMEOUT.*after 4 attempts.*school address \(https:\/\/s\.example\.edu\)/);
  assert.deepEqual([school.code, school.host, school.attempts], ['UND_ERR_CONNECT_TIMEOUT', 's.example.edu', 4]);

  const storage = networkError(failure('ECONNRESET', { message: `lost ${STORAGE}` }), { url: STORAGE, base: 'https://s.example.edu' });
  assert.match(storage.message, /files\.example\.net/);
  assert.doesNotMatch(storage.message, /school address|SIGNED-SECRET/);
  assert.equal(hideAddresses(`(see ${STORAGE})`), '(see files.example.net)');
});

test('fetchWithRetry builds the request again each time and does not repeat a timeout', async () => {
  let built = 0;
  let tries = 0;
  const res = await fetchWithRetry(async (url, init) => { assert.equal(init.body, ++tries); if (tries < 2) throw failure('ECONNRESET'); return new Response('ok'); }, 'https://x.example/', () => ({ body: ++built }), { timeoutMs: 1000 });
  assert.equal(await res.text(), 'ok');
  assert.equal(built, 2);

  let slow = 0;
  await assert.rejects(fetchWithRetry(async () => { slow++; throw new DOMException('slow', 'TimeoutError'); }, 'https://x.example/', () => ({}), { timeoutMs: 1000 }), /didn't answer/);
  assert.equal(slow, 1);
});

test('a real upload survives a dropped storage connection and sends the whole form again', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v1/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ upload_url: `http://127.0.0.1:${server.address().port}/storage?sig=x`, upload_params: { key: 'folder/essay.txt' } }));
      return;
    }
    if (!bodies.length) { bodies.push(''); req.socket.destroy(); return; }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { bodies.push(body); res.setHeader('content-type', 'application/json'); res.end('{"id":"55"}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const canvas = new CanvasClient({ api: `${base}/api/v1`, token: 't', ttl: 0, base });
  const { file } = upload();
  try {
    const { uploadFile } = createShared({ canvas, cfg: { base, token: 't' }, dates: {} });
    assert.equal((await uploadFile('/users/self/files', file)).id, '55');
    assert.equal(bodies.length, 2, 'the storage upload was tried twice');
    assert.match(bodies[1], /folder\/essay\.txt/);
    assert.match(bodies[1], /hello/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('a failed upload says which step broke, in the answer and in the log, without the signed address or the token', async () => {
  const lines = [];
  const { file, override } = upload({ error: failure('ECONNRESET') });
  const s = await connect({ override, log: (l) => lines.push(l) });
  const res = await s.client.callTool({ name: 'upload_to_my_files', arguments: { file_path: file } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /step 2 of 3 \(storage upload on files\.example\.net\).*ECONNRESET.*after 4 attempts/);
  assert.doesNotMatch(textOf(res), /SIGNED-SECRET|school address/);
  const line = lines.find((l) => l.includes('tool failed'));
  assert.match(line, /^\d{4}-\d\d-\d\dT.*tool failed: upload_to_my_files step="storage upload" host=files\.example\.net code=ECONNRESET attempts=4: /);
  assert.doesNotMatch(lines.join('\n'), /SIGNED-SECRET|test-token-123456/);
  await s.close();
});

test('a submission that fails after the upload is not repeated and says to check first', async () => {
  const calls = [];
  const lines = [];
  const { file, override } = upload({ body: { id: '77', filename: 'essay.txt', size: 5 } }, (method, p) => (method === 'POST' && p.endsWith('/submissions') ? { error: failure('ECONNRESET') } : undefined));
  const s = await connect({ calls, override, log: (l) => lines.push(l) });
  const res = await s.client.callTool({ name: 'submit_assignment_file', arguments: { course_id: '1', assignment_id: '1', file_path: file, confirm: true } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /file id 77.*creating the submission failed.*get_my_submission/);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/submissions')).length, 1);
  assert.match(lines.join('\n'), /step="submission create"/);
  await s.close();
});

test('a missing file names the computer the server runs on', async () => {
  const s = await connect();
  const res = await s.client.callTool({ name: 'upload_to_my_files', arguments: { file_path: path.join(os.tmpdir(), 'no-such-canvas-file.txt') } });
  assert.match(textOf(res), new RegExp(`File not found on the computer running this server \\(${os.hostname()}\\)`));
  await s.close();
});

test('a file download survives a dropped connection', async () => {
  let n = 0;
  const { fetchFile } = createShared({ canvas: client(async () => new Response('{}')), cfg: { token: 't', base: '' }, dates: {}, fetchImpl: async () => { if (++n < 2) throw new TypeError('fetch failed'); return new Response('data'); } });
  assert.equal(await (await fetchFile('https://x.example/f')).text(), 'data');
});

const lookedUp = (lookup, host, options) => new Promise((resolve, reject) => { lookup(host, options, (e, ...answer) => (e ? reject(e) : resolve(answer))); });
const ADDRESSES = [{ address: '192.0.2.1', family: 4 }, { address: '192.0.2.2', family: 4 }];

test('a slow system DNS lookup is overtaken by asking the DNS server, on every lookup', async () => {
  const stalled = () => {};
  const asked = [];
  const lookup = patientLookup({ system: stalled, direct: async (host, family) => { asked.push([host, family]); return ADDRESSES; }, waitMs: 5 });
  assert.deepEqual(await lookedUp(lookup, 'school.test', { all: true }), [ADDRESSES]);
  assert.deepEqual(await lookedUp(lookup, 'school.test', {}), ['192.0.2.1', 4]);
  assert.deepEqual(await lookedUp(lookup, 'school.test', 4), ['192.0.2.1', 4]);
  assert.deepEqual(asked, [['school.test', undefined], ['school.test', undefined], ['school.test', 4]]);
});

test('the system lookup still decides when it is quick, when it fails, or when the DNS server has no answer', async () => {
  let asked = 0;
  const direct = async () => { asked++; return ADDRESSES; };
  const quick = patientLookup({ system: (h, o, cb) => cb(null, '127.0.0.1', 4), direct, waitMs: 5 });
  assert.deepEqual(await lookedUp(quick, 'hosts-file.test', {}), ['127.0.0.1', 4]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked, 0, 'a quick answer never reaches the DNS server');

  const missing = patientLookup({ system: (h, o, cb) => cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })), direct, waitMs: 5 });
  await assert.rejects(lookedUp(missing, 'nothing.test', {}), { code: 'ENOTFOUND' });

  const lateSystem = patientLookup({ system: (h, o, cb) => setTimeout(() => cb(null, '127.0.0.1', 4), 30), direct: async () => { throw new Error('no answer'); }, waitMs: 5 });
  assert.deepEqual(await lookedUp(lateSystem, 'vpn-only.test', {}), ['127.0.0.1', 4]);
});

test('with every system lookup stalled, real requests still connect, each on a new connection', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.setHeader('connection', 'close'); res.setHeader('content-type', 'application/json'); res.end('{"upload_url":"x"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://school.test:${server.address().port}`;
  const canvas = new CanvasClient({ api: `${base}/api/v1`, token: 't', ttl: 0, base });
  const original = dns.lookup;
  let lookups = 0;
  dns.lookup = patientLookup({ system: () => { lookups++; }, direct: async () => [{ address: '127.0.0.1', family: 4 }], waitMs: 20 });
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(await canvas.post('/users/self/files', { name: 'essay.docx' }), { upload_url: 'x' });
    assert.equal(requests, 3);
    assert.equal(lookups, 3, 'every request needed a new lookup');
  } finally {
    dns.lookup = original;
    server.closeAllConnections?.();
    server.close();
  }
});

test('CANVAS_IP_FAMILY limits DNS to one family, and can be turned off again', async () => {
  const original = dns.lookup;
  assert.equal(readConfig({ CANVAS_IP_FAMILY: '4' }).ipFamily, 4);
  assert.equal(readConfig({ CANVAS_IP_FAMILY: '6' }).ipFamily, 6);
  assert.equal(readConfig({ CANVAS_IP_FAMILY: '5' }).ipFamily, null);
  assert.equal(readConfig({}).ipFamily, null);
  try {
    applyNetworkSettings({ ipFamily: 4 });
    const all = await new Promise((resolve, reject) => { dns.lookup('localhost', { all: true }, (e, a) => (e ? reject(e) : resolve(a))); });
    assert.ok(all.length && all.every((a) => a.family === 4));
    const family = await new Promise((resolve, reject) => { dns.lookup('localhost', (e, a, f) => (e ? reject(e) : resolve(f))); });
    assert.equal(family, 4);
    applyNetworkSettings();
    const both = await new Promise((resolve, reject) => { dns.lookup('127.0.0.1', { all: true }, (e, a) => (e ? reject(e) : resolve(a))); });
    assert.deepEqual(both, [{ address: '127.0.0.1', family: 4 }]);
  } finally {
    dns.lookup = original;
  }
});

test('the doctor report calls out slow DNS and blocked addresses, and passes a healthy network', async () => {
  const report = async (answer) => {
    const lines = [];
    await reportConnections('https://s.example.edu', { good: (m) => lines.push(`good: ${m}`), bad: (m, fix) => lines.push(`bad: ${m} / ${fix}`) }, async () => answer);
    return lines.join('\n');
  };
  const healthy = await report({ lookupMs: 40, results: [{ address: '192.0.2.1', ok: true, totalMs: 90 }, { address: '192.0.2.2', ok: true, totalMs: 120 }] });
  assert.match(healthy, /good: DNS answered in 40 ms \(2 addresses\)/);
  assert.match(healthy, /good: Opened a new secure connection to all 2 addresses \(slowest 120 ms\)/);
  assert.doesNotMatch(healthy, /bad:/);
  assert.match(await report({ lookupMs: 11200, directMs: 25, results: [{ address: '192.0.2.1', ok: true, totalMs: 90 }] }), /bad: This computer's DNS lookup for s\.example\.edu took 11\.2 seconds, but the DNS server answered in 25 ms \/ The Canvas server works around this/);
  assert.match(await report({ lookupMs: 10000, lookupError: 'no answer in 10 seconds', directMs: 25, results: [{ address: '192.0.2.1', ok: true, totalMs: 90 }] }), /bad: This computer's DNS lookup for s\.example\.edu failed \(no answer in 10 seconds\), but the DNS server answered in 25 ms[\s\S]*good: Opened a new secure connection to the address/);
  assert.match(await report({ lookupMs: 20, lookupError: 'ENOTFOUND', directMs: null, results: [] }), /bad: DNS couldn't find s\.example\.edu \(ENOTFOUND\)/);
  assert.match(await report({ lookupMs: 20, results: [{ address: '192.0.2.1', ok: false, error: 'TLS: ECONNRESET' }, { address: '192.0.2.2', ok: true, totalMs: 90 }] }), /bad: Couldn't open a connection to 1 of 2 addresses: 192\.0\.2\.1 \(TLS: ECONNRESET\).*firewall/);
});

test('the connection check reports a closed port and an unknown host without throwing', async () => {
  const free = http.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const { port } = free.address();
  await new Promise((r) => free.close(r));
  const closed = await checkConnections('localhost', { port, timeoutMs: 3000 });
  assert.ok(closed.results.length && closed.results.every((r) => r.ok === false && r.error));

  const unknown = await checkConnections('nothing.invalid', { timeoutMs: 3000 });
  assert.ok(unknown.lookupError);
  assert.deepEqual(unknown.results, []);
});
