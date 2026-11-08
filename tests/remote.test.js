// The Remote Edition's own parts: two-factor codes, log rotation, .env edits, sign-in tracking and lockout, the status
// page, the new alert types and channels, startup-service files and the new HTTP endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { totp, verifyTotp, base32Encode, base32Decode, otpauthUrl } from '../totp.js';
import { createRotatingLog } from '../log-file.js';
import { setEnvValues, readEnv } from '../env-file.js';
import { createOAuthProvider, passwordMatches } from '../oauth-provider.js';
import { createStatusRouter } from '../status-page.js';
import { alertSettings, collectAlerts, planDelivery, digestDue, buildDigest, deliver, describeAlerts, courseAllowed, inQuietHours } from '../alerts.js';
import { systemdUnit, launchdPlist } from '../service.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-remote-'));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
/** A reply as JSON, or a failure that says which request answered with what. */
async function jsonOf(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`${res.url} answered HTTP ${res.status}, not JSON: ${text.slice(0, 300)}`); }
}

test('two-factor codes match the RFC 6238 test vector', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp(secret, { now: 59000 }), '287082');
  assert.equal(totp(secret, { now: 1111111109000 }), '081804');
  assert.ok(verifyTotp(secret, '287082', { now: 59000 }));
  assert.ok(verifyTotp(secret, '287 082', { now: 59000 + 30000 }), 'one step of clock drift is fine');
  assert.ok(!verifyTotp(secret, '287082', { now: 59000 + 120000 }));
  assert.ok(!verifyTotp(secret, 'abc', { now: 59000 }));
  assert.deepEqual(base32Decode(secret), Buffer.from('12345678901234567890'));
  assert.match(otpauthUrl(secret), /^otpauth:\/\/totp\/Canvas%20MCP\?secret=GEZ/);
});

test('the log rotates at its size limit and keeps a few old files', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'supervisor.log');
    const log = createRotatingLog(file, { maxBytes: 100, keep: 2 });
    for (let i = 0; i < 12; i++) log.write(`${'x'.repeat(30)} line ${i}\n`);
    assert.ok(fs.statSync(file).size <= 100);
    assert.ok(fs.existsSync(`${file}.1`) && fs.existsSync(`${file}.2`));
    assert.ok(!fs.existsSync(`${file}.3`), 'never more than `keep` old files');
    assert.match(fs.readFileSync(file, 'utf8'), /line 11/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('.env edits keep other lines and back the file up', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '# my settings\nCANVAS_BASE_URL=https://s.example.edu\nCANVAS_MCP_PASSWORD=old-password-1234\nCANVAS_MCP_TOTP_SECRET=ABC\n');
    const backup = setEnvValues(file, { CANVAS_MCP_PASSWORD: 'new pass with spaces', CANVAS_MCP_TOTP_SECRET: null, CANVAS_ALERTS: 'grades' });
    const v = readEnv(file);
    assert.equal(v.CANVAS_MCP_PASSWORD, 'new pass with spaces');
    assert.equal(v.CANVAS_MCP_TOTP_SECRET, undefined);
    assert.equal(v.CANVAS_ALERTS, 'grades');
    assert.match(fs.readFileSync(file, 'utf8'), /^# my settings\nCANVAS_BASE_URL=https:\/\/s\.example\.edu/);
    assert.match(fs.readFileSync(backup, 'utf8'), /old-password-1234/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '', redirected: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.redirect = (u) => { r.redirected = u; return r; };
  return r;
}

test('sign-ins: listed, signed out, tidied, locked out after wrong passwords, and two-factor when on', async () => {
  const dir = tmp();
  try {
    let clock = Date.parse('2026-11-02T12:00:00Z');
    const logins = [];
    const auth = createOAuthProvider({ password: 'correct horse battery', storePath: path.join(dir, 'store.json'), historyPath: path.join(dir, 'history.json'), onLogin: (e) => logins.push(e), now: () => clock });
    const chat = auth.provider.clientsStore.registerClient({ client_name: 'ChatGPT', redirect_uris: ['https://chat.example/cb'] });
    const stale = auth.provider.clientsStore.registerClient({ client_name: 'Abandoned', redirect_uris: ['https://x.example/cb'] });
    const form = (extra) => ({ ip: '203.0.113.9', body: { client_id: chat.client_id, redirect_uri: 'https://chat.example/cb', code_challenge: 'abc', state: 's', ...extra } });

    const wrongRedirect = fakeRes();
    auth.approveHandler({ ...form({ password: 'correct horse battery' }), body: { ...form().body, redirect_uri: 'https://evil.example/cb', password: 'correct horse battery' } }, wrongRedirect);
    assert.equal(wrongRedirect.statusCode, 400, 'a return address the app did not register is refused');

    const okRes = fakeRes();
    auth.approveHandler(form({ password: 'correct horse battery' }), okRes);
    const code = new URL(okRes.redirected).searchParams.get('code');
    const tokens = await auth.provider.exchangeAuthorizationCode(chat, code);
    assert.ok(tokens.access_token);
    clock += 10 * 60000;
    await auth.provider.verifyAccessToken(tokens.access_token);
    const sessions = auth.listSessions();
    assert.equal(sessions[0].app, 'ChatGPT');
    assert.equal(sessions[0].signed_in, true);
    assert.equal(sessions[0].last_used, new Date(clock).toISOString());
    assert.deepEqual(logins.map((l) => l.ok), [true]);

    clock += 8 * 86400000;
    assert.deepEqual(auth.prune(), { removed_apps: 1, removed_tokens: 1 }, 'the app that never signed in is removed; the expired access token too');
    assert.equal(auth.listSessions().length, 1);
    assert.ok(!auth.listSessions().some((s) => s.client_id === stale.client_id));

    for (let i = 0; i < 5; i++) auth.approveHandler(form({ password: 'nope' }), fakeRes());
    const locked = fakeRes();
    auth.approveHandler(form({ password: 'correct horse battery' }), locked);
    assert.equal(locked.statusCode, 429, 'the address is locked even with the right password');
    assert.ok(logins.some((l) => l.locked));
    assert.equal(auth.loginHistory(50).filter((h) => !h.ok).length, 5);

    assert.ok(auth.revokeClient(chat.client_id));
    await assert.rejects(auth.provider.verifyAccessToken(tokens.access_token));
    assert.ok(passwordMatches('a', 'a') && !passwordMatches('a', 'b') && !passwordMatches('', ''));

    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const two = createOAuthProvider({ password: 'pw-123456789', storePath: path.join(dir, 'store2.json'), totpSecret: secret, now: () => 59000 });
    const app = two.provider.clientsStore.registerClient({ client_name: 'Claude', redirect_uris: ['https://c.example/cb'] });
    const base = { ip: '198.51.100.1', body: { client_id: app.client_id, redirect_uri: 'https://c.example/cb', code_challenge: 'x', password: 'pw-123456789' } };
    const noCode = fakeRes();
    two.approveHandler(base, noCode);
    assert.equal(noCode.statusCode, 401);
    assert.match(noCode.body, /authenticator app/);
    const withCode = fakeRes();
    two.approveHandler({ ...base, body: { ...base.body, code: '287082' } }, withCode);
    assert.ok(withCode.redirected);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the status page asks for the password, then shows the dashboard and signs apps out', async () => {
  const revoked = [];
  const app = express();
  app.use('/status', createStatusRouter({
    password: 'status-pass-123',
    getStatus: async () => ({ hostname: 'study-pc', public_url: 'https://x.example', version: '1.3.0', tools: 237, started_at: new Date().toISOString(), uptime: '5 minutes', tunnel: 'ngrok', base_url: 'https://s.example.edu', canvas_user: 'Alex Example', token: { expires_at: new Date(Date.now() + 3 * 86400000).toISOString(), days_left: 3 }, alerts: { on: true, channels: ['ntfy'], types: ['grades'], every_minutes: 15 }, sessions: [{ client_id: 'c1', app: 'ChatGPT', signed_in: true, last_used: new Date().toISOString() }], logins: [{ at: new Date().toISOString(), ok: false, reason: 'wrong password', ip: '1.2.3.4' }], cluster: [{ hostname: 'study-pc', state: 'active', self: true }], problems: [] }),
    revokeClient: (id) => revoked.push(id),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/status`;
  try {
    assert.match(await (await fetch(base)).text(), /Enter your server password/);
    const wrong = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: 'nope' }), redirect: 'manual' });
    assert.equal(wrong.status, 401);
    const right = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: 'status-pass-123' }), redirect: 'manual' });
    assert.equal(right.status, 303);
    const cookie = right.headers.get('set-cookie').split(';')[0];
    assert.match(right.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
    const page = await (await fetch(base, { headers: { cookie } })).text();
    assert.match(page, /served by <b>study-pc<\/b>/);
    assert.match(page, /Alex Example/);
    assert.match(page, /expires .* \(3 days\)/);
    assert.match(page, /wrong password/);
    const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
    const forged = await fetch(`${base}/sessions/c1/sign-out`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf: 'forged' }), redirect: 'manual' });
    assert.equal(forged.status, 403);
    const out = await fetch(`${base}/sessions/c1/sign-out`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf }), redirect: 'manual' });
    assert.equal(out.status, 303);
    assert.deepEqual(revoked, ['c1']);
    const tampered = await (await fetch(base, { headers: { cookie: cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) } })).text();
    assert.match(tampered, /Enter your server password/, 'a changed cookie is not accepted');
  } finally { server.close(); }
});

test('new alert types: new assignments, teacher comments, inbox messages and a grade drop', () => {
  const now = new Date('2026-11-02T15:00:00Z');
  const settings = alertSettings({ CANVAS_ALERTS_NTFY_TOPIC: 't', CANVAS_ALERTS: 'assignments,comments,inbox,grade_drop', CANVAS_ALERTS_GRADE_BELOW: '75' });
  const upcoming = [{ plannable_type: 'assignment', plannable_id: 1, plannable: { title: 'Lab 1' }, course_id: 3, context_name: 'Biology' }];
  const first = collectAlerts({ upcoming, now, settings, state: {} });
  assert.deepEqual(first.alerts, [], 'the first run only remembers what exists');
  const added = [...upcoming, { plannable_type: 'quiz', plannable_id: 2, plannable: { title: 'Quiz 2', due_at: '2026-11-05T04:59:00Z', points_possible: 10 }, course_id: 3, context_name: 'Biology', html_url: '/courses/3/quizzes/2' }];
  const stream = [{ type: 'Submission', course_id: 3, updated_at: '2026-11-02T14:00:00Z', assignment: { name: 'Lab 1' }, html_url: '/courses/3/assignments/1', submission_comments: [{ author_id: '9', author_name: 'Dr. Example', created_at: '2026-11-02T14:00:00Z', comment: 'Great <b>work</b>' }, { author_id: '5', created_at: '2026-11-02T14:00:00Z', comment: 'my own reply' }] }];
  const conversations = [{ last_message_at: '2026-11-02T14:30:00Z', subject: 'Office hours', last_message: 'Moved to 3pm', participants: [{ id: '5', name: 'Me' }, { id: '9', name: 'Dr. Example' }] }];
  const grades = [{ course_id: 3, name: 'Biology', score: 72.5 }, { course_id: 4, name: 'Art', score: 95 }];
  const second = collectAlerts({ upcoming: added, stream, conversations, grades, me: '5', now, settings, state: { ...first.state, last_check: '2026-11-02T13:00:00Z' }, baseUrl: 'https://s.example.edu', courseNames: { 3: 'Biology' } });
  const byType = Object.fromEntries(second.alerts.map((a) => [a.type, a]));
  assert.equal(byType.assignments.title, 'New quiz in Biology');
  assert.match(byType.assignments.message, /^Quiz 2, due .* \(10 points\)$/);
  assert.equal(byType.comments.title, 'New comment from Dr. Example');
  assert.match(byType.comments.message, /Great work/);
  assert.equal(second.alerts.filter((a) => a.type === 'comments').length, 1, 'your own comments are skipped');
  assert.equal(byType.inbox.title, 'New message from Dr. Example');
  assert.equal(byType.grade_drop.title, 'Biology is at 72.5%');
  const third = collectAlerts({ upcoming: added, grades, now, settings, state: second.state });
  assert.ok(!third.alerts.some((a) => a.type === 'grade_drop'), 'a grade drop is announced once');
  const lower = collectAlerts({ upcoming: added, grades: [{ course_id: 3, name: 'Biology', score: 70 }], now, settings, state: second.state });
  assert.ok(lower.alerts.some((a) => a.type === 'grade_drop'), 'and again if it falls further');
});

test('course filters, quiet hours and digest mode', () => {
  const f = alertSettings({ CANVAS_ALERTS_NTFY_TOPIC: 't', CANVAS_ALERTS_COURSES: 'bio,42', CANVAS_ALERTS_SKIP_COURSES: 'lab' });
  assert.ok(courseAllowed(1, 'Biology 101', f));
  assert.ok(courseAllowed(42, 'Art', f));
  assert.ok(!courseAllowed(7, 'Chemistry', f));
  assert.ok(!courseAllowed(8, 'Biology Lab', f));

  const quiet = alertSettings({ CANVAS_ALERTS_NTFY_TOPIC: 't', CANVAS_ALERTS_QUIET: '22:00-07:00', CANVAS_TIMEZONE: 'UTC' });
  const night = new Date('2026-11-02T23:30:00Z');
  assert.ok(inQuietHours(night, quiet));
  const alerts = [1, 2, 3, 4].map((n) => ({ type: 'grades', title: `Grade ${n}` })).concat({ type: 'security', title: 'New sign-in' });
  const held = planDelivery({ alerts, settings: quiet, now: night });
  assert.deepEqual(held.send.map((a) => a.type), ['security'], 'only security alerts go out at night');
  assert.equal(held.state.queued.length, 4);
  const morning = planDelivery({ alerts: [], state: held.state, settings: quiet, now: new Date('2026-11-03T07:05:00Z') });
  assert.equal(morning.send.length, 1);
  assert.equal(morning.send[0].title, 'While you were away: 4 alerts');

  const digest = alertSettings({ CANVAS_ALERTS_NTFY_TOPIC: 't', CANVAS_ALERTS_DIGEST: '7:30', CANVAS_ALERTS_MODE: 'digest', CANVAS_TIMEZONE: 'UTC' });
  assert.equal(digest.digest, '07:30');
  const sent = planDelivery({ alerts: [{ type: 'grades', title: 'g' }, { type: 'due', title: 'd' }], settings: digest, now: new Date('2026-11-02T12:00:00Z') });
  assert.deepEqual(sent.send.map((a) => a.type), ['due'], 'in digest mode only urgent alerts go out right away');
  assert.ok(!digestDue(new Date('2026-11-02T07:00:00Z'), digest, {}));
  assert.ok(digestDue(new Date('2026-11-02T07:31:00Z'), digest, {}));
  assert.ok(!digestDue(new Date('2026-11-02T09:00:00Z'), digest, { digest_sent_on: '2026-11-02' }));
  const d = buildDigest({ planner: [{ plannable: { title: 'Essay', due_at: '2026-11-02T23:00:00Z' }, context_name: 'English' }], missingCount: 2, unreadCount: 1, settings: digest, now: new Date('2026-11-02T07:31:00Z') });
  assert.equal(d.title, 'Your Canvas day: 1 due today');
  assert.match(d.message, /Due today: Essay \(English, 11:00 PM\)\nMissing work: 2\nUnread messages: 1/);
  assert.match(describeAlerts(digest).digest, /07:30 \(only urgent alerts in between\)/);
});

test('alerts go to Telegram, Slack, Teams and Pushover too', async () => {
  const calls = [];
  const settings = alertSettings({ CANVAS_ALERTS_TELEGRAM_TOKEN: '123:abc', CANVAS_ALERTS_TELEGRAM_CHAT_ID: '42', CANVAS_ALERTS_SLACK_WEBHOOK: 'https://hooks.slack.example/x', CANVAS_ALERTS_TEAMS_WEBHOOK: 'https://teams.example/hook', CANVAS_ALERTS_PUSHOVER_TOKEN: 'pt', CANVAS_ALERTS_PUSHOVER_USER: 'pu' });
  await deliver({ type: 'due', title: 'Due in 2 hours: <Essay>', message: 'English', url: 'https://x/1' }, settings, async (url, opts) => { calls.push({ url, opts }); return { ok: true }; });
  const by = (part) => calls.find((c) => c.url.includes(part));
  assert.deepEqual(JSON.parse(by('telegram').opts.body), { chat_id: '42', text: 'Due in 2 hours: <Essay>\nEnglish\nhttps://x/1', disable_web_page_preview: true });
  assert.equal(JSON.parse(by('slack').opts.body).text, '*Due in 2 hours: &lt;Essay&gt;*\nEnglish\n<https://x/1|Open in Canvas>');
  assert.equal(JSON.parse(by('teams').opts.body).attachments[0].content.actions[0].url, 'https://x/1');
  const po = new URLSearchParams(by('pushover').opts.body);
  assert.equal(po.get('user'), 'pu');
  assert.equal(po.get('priority'), '1', 'due alerts are high priority');
});

test('startup service files run the supervisor with a rotating log', () => {
  const unit = systemdUnit({ dir: '/home/a/canvas', node: '/usr/bin/node', cli: '/opt/c/cli.js' });
  assert.match(unit, /WorkingDirectory=\/home\/a\/canvas\nExecStart=\/usr\/bin\/node \/opt\/c\/cli\.js start --log-file supervisor\.log/);
  assert.match(unit, /Restart=on-failure/);
  const plist = launchdPlist({ dir: '/Users/a/canvas & co', node: '/opt/homebrew/bin/node', cli: '/opt/c/cli.js' });
  assert.match(plist, /<string>--log-file<\/string><string>supervisor\.log<\/string>/);
  assert.match(plist, /canvas &amp; co/);
});

test('HTTP with sign-in on: status page, cluster heartbeats and a health check that says nothing private', { timeout: 30000 }, async () => {
  const dir = tmp();
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: dir,
    env: { ...process.env, CANVAS_API_TOKEN: 'test-token', CANVAS_BASE_URL: 'https://canvas.example.edu', CANVAS_MCP_PORT: String(port), CANVAS_MCP_TRANSPORT: 'http', CANVAS_MCP_PUBLIC_URL: 'https://demo.example.dev', CANVAS_MCP_PASSWORD: 'a-long-test-password', CANVAS_MCP_CLUSTER_SECRET: 'cluster-secret-123', CANVAS_ALERTS_NTFY_TOPIC: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errText = '';
  child.stderr.on('data', (d) => { errText += d; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${errText}`)), 20000);
      child.stderr.on('data', (d) => { if (String(d).includes('ready on http://')) { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => reject(new Error(`server exited early (code ${code}): ${errText}`)));
    });
    const h = { Host: 'demo.example.dev' };
    const health = await jsonOf(await fetch(`http://127.0.0.1:${port}/healthz`, { headers: h }));
    assert.deepEqual(Object.keys(health).sort(), ['auth_enabled', 'ok', 'tools', 'version']);
    assert.equal(health.auth_enabled, true);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/status`, { headers: h })).text(), /Enter your server password/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/status`, { headers: h })).status, 403);
    const secret = { ...h, 'X-Cluster-Secret': 'cluster-secret-123', 'Content-Type': 'application/json' };
    await fetch(`http://127.0.0.1:${port}/internal/heartbeat`, { method: 'POST', headers: secret, body: JSON.stringify({ hostname: 'laptop-2', state: 'standby', version: '1.3.0' }) });
    const { members } = await jsonOf(await fetch(`http://127.0.0.1:${port}/internal/cluster`, { headers: secret }));
    assert.deepEqual(members.map((m) => m.state), ['active', 'standby']);
    assert.equal(members[1].hostname, 'laptop-2');
    const status = await jsonOf(await fetch(`http://127.0.0.1:${port}/internal/status`, { headers: secret }));
    assert.equal(status.tools, 237);
    assert.deepEqual(status.sessions, []);
    assert.ok(!JSON.stringify(status).includes('a-long-test-password') && !JSON.stringify(status).includes('test-token'));
    const meta = await jsonOf(await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`, { headers: h }));
    assert.equal(meta.issuer, 'https://demo.example.dev/');
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('an option value is never taken for the command', async () => {
  const dir = tmp();
  const runCli = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'cli.js'), ...args], { cwd: dir, env: { ...process.env, CANVAS_API_TOKEN: '' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out));
  });
  try {
    assert.doesNotMatch(await runCli('--lines', '5', 'logs'), /Unknown command/);
    assert.doesNotMatch(await runCli('sessions', '--name', 'x'), /Unknown command/);
    assert.match(await runCli('--lines', '5', 'nonsense'), /Unknown command: nonsense/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('updating from 1.2.x keeps apps that are still signed in, however long ago they registered', () => {
  const dir = tmp();
  try {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const registered = Math.floor((now - 200 * 86400000) / 1000);
    const storePath = path.join(dir, 'oauth-store.json');
    // What 1.2.x left behind: no last_used_at on the app, no issuedAt on the refresh token.
    fs.writeFileSync(storePath, JSON.stringify({
      clients: { old: { client_id: 'old', client_name: 'Claude', client_id_issued_at: registered, redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } },
      refreshTokens: { r1: { clientId: 'old', scopes: [] } },
      accessTokens: {},
    }));
    const auth = createOAuthProvider({ password: 'pw', storePath, now: () => now });
    assert.deepEqual(auth.prune(), { removed_apps: 0, removed_tokens: 0 });
    const s = auth.listSessions();
    assert.equal(s.length, 1);
    assert.equal(s[0].signed_in, true, 'Claude stays signed in after the update');
    assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).clients.old.last_used_at, new Date(now).toISOString(), 'its 90-day clock starts now');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
