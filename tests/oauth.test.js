// How sign-in holds up against someone who knows your public address: a look-alike app, a reused or stolen code or
// token, and a token meant for another server. Unit tests on the provider with a fake clock; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createOAuthProvider } from '../oauth-provider.js';
import { createStatusRouter } from '../status-page.js';
import { generateSecret, totp } from '../totp.js';

const PASSWORD = 'correct horse battery';
const RESOURCE = 'https://demo.example.dev/mcp';

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '', redirected: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.set = (k, v) => { if (typeof k === 'object') Object.assign(r.headers, k); else r.headers[k] = v; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.redirect = (u) => { r.redirected = u; return r; };
  return r;
}

/** A provider in a temp folder, with a clock the test moves. */
function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-oauth-'));
  const clock = { now: Date.parse('2026-11-07T12:00:00Z') };
  const auth = createOAuthProvider({ password: PASSWORD, storePath: path.join(dir, 'store.json'), historyPath: path.join(dir, 'history.json'), resourceUrl: RESOURCE, now: () => clock.now, ...options });
  const register = (meta) => auth.provider.clientsStore.registerClient({ token_endpoint_auth_method: 'none', ...meta });
  let ip = 0;
  const approve = (client, body = {}) => {
    const res = fakeRes();
    auth.approveHandler({ ip: `203.0.113.${++ip % 250}`, body: { client_id: client.client_id, redirect_uri: client.redirect_uris?.[0], code_challenge: 'challenge', state: 's', password: PASSWORD, ...body } }, res);
    return res;
  };
  const codeFrom = (res) => new URL(res.redirected).searchParams.get('code');
  const signIn = async (client, body) => auth.provider.exchangeAuthorizationCode(client, codeFrom(approve(client, body)));
  const page = async (client, redirectUri = client.redirect_uris[0]) => {
    const res = fakeRes();
    await auth.provider.authorize(client, { redirectUri, codeChallenge: 'challenge', state: 's', scopes: [] }, res);
    return res;
  };
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { auth, clock, register, approve, codeFrom, signIn, page, cleanup, dir };
}

/** The page's words, without the hidden form fields, which a person never sees. */
const visible = (html) => html.replace(/<input[^>]*>/g, '').replace(/<[^>]+>/g, ' ');

// ---------------------------------------------------------------------------------------------------------------
// F8: a look-alike app on your real sign-in page
// ---------------------------------------------------------------------------------------------------------------

test('the sign-in page shows where you go back to', async () => {
  const s = setup();
  try {
    const app = s.register({ client_name: 'Study helper', redirect_uris: ['https://helper.example.org/oauth/callback'] });
    const text = visible((await s.page(app)).body);
    assert.match(text, /helper\.example\.org/);
  } finally { s.cleanup(); }
});

test('an app that calls itself Claude but goes back somewhere else gets a clear warning', async () => {
  const s = setup();
  try {
    const fake = s.register({ client_name: 'Claude', redirect_uris: ['https://evil.example/cb'] });
    const res = await s.page(fake);
    assert.match(visible(res.body), /evil\.example/);
    assert.match(res.body, /role="alert"/);
    assert.match(visible(res.body), /isn't Claude/);

    const real = s.register({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const ok = await s.page(real);
    assert.doesNotMatch(ok.body, /role="alert"/, 'the real Claude gets no warning');

    const chat = s.register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] });
    assert.doesNotMatch((await s.page(chat)).body, /role="alert"/);
    const fakeChat = s.register({ client_name: 'OpenAI ChatGPT', redirect_uris: ['https://chatgpt.example.net/cb'] });
    assert.match((await s.page(fakeChat)).body, /role="alert"/);
  } finally { s.cleanup(); }
});

test('an app on this computer is named as such, and an unknown website is flagged', async () => {
  const s = setup();
  try {
    const local = s.register({ client_name: 'Desktop client', redirect_uris: ['http://127.0.0.1:33418/callback'] });
    const localText = visible((await s.page(local)).body);
    assert.match(localText, /this computer|this device/);
    assert.doesNotMatch(localText, /isn't an app this server knows/);

    const site = s.register({ client_name: 'Desktop client', redirect_uris: ['https://unknown.example/cb'] });
    assert.match(visible((await s.page(site)).body), /isn't an app this server knows/);
  } finally { s.cleanup(); }
});

test('an app with no return address can\'t register, and an old one can\'t sign in', async () => {
  const s = setup();
  try {
    assert.throws(() => s.register({ client_name: 'empty', redirect_uris: [] }), /return address/i);
    assert.ok(!fs.existsSync(path.join(s.dir, 'store.json')), 'nothing was saved');
    // One registered before this check, still in the store.
    const store = { clients: {}, refreshTokens: {}, accessTokens: {} };
    store.clients.legacy = { client_id: 'legacy', client_name: 'legacy', redirect_uris: [] };
    fs.writeFileSync(path.join(s.dir, 'store.json'), JSON.stringify(store));
    const res = s.approve({ client_id: 'legacy' }, { redirect_uri: 'https://anywhere.example/cb' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.redirected, null, 'no code went anywhere');
  } finally { s.cleanup(); }
});

test('registrations are capped: old ones that never signed in make room, signed-in apps stay', async () => {
  const s = setup();
  try {
    const kept = s.register({ client_name: 'Kept', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    await s.signIn(kept);
    for (let i = 0; i < 130; i++) { s.clock.now += 1000; s.register({ client_name: `junk ${i}`, redirect_uris: ['https://junk.example/cb'] }); }
    const ids = Object.keys(JSON.parse(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8')).clients);
    assert.ok(ids.length <= 100, `${ids.length} apps registered`);
    assert.ok(ids.includes(kept.client_id), 'the signed-in app is still there');
    assert.equal(s.auth.listSessions().find((x) => x.client_id === kept.client_id)?.signed_in, true);
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// F19: codes and tokens
// ---------------------------------------------------------------------------------------------------------------

test('with two-factor on, a wrong password and a wrong code look the same', async () => {
  const secret = generateSecret();
  const s = setup({ totpSecret: secret });
  try {
    const app = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const message = (res) => (/class="error"[^>]*>([^<]*)/.exec(res.body) || [])[1];
    const wrongPassword = s.approve(app, { password: 'nope', code: totp(secret, { now: s.clock.now }) });
    const wrongCode = s.approve(app, { code: '000000' });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(wrongCode.statusCode, 401);
    assert.equal(message(wrongPassword), message(wrongCode));
  } finally { s.cleanup(); }
});

test('a two-factor code works once', async () => {
  const secret = generateSecret();
  const s = setup({ totpSecret: secret });
  try {
    const app = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const code = totp(secret, { now: s.clock.now });
    assert.ok(s.approve(app, { code }).redirected, 'first use signs in');
    const again = s.approve(app, { code });
    assert.equal(again.statusCode, 401, 'the same code is refused the second time');
    s.clock.now += 30000;
    assert.ok(s.approve(app, { code: totp(secret, { now: s.clock.now }) }).redirected, 'the next code works');
  } finally { s.cleanup(); }
});

test('a code used to sign an app in can\'t open the status page too', async () => {
  const secret = generateSecret();
  const s = setup({ totpSecret: secret });
  const app = express();
  app.use('/status', createStatusRouter({ password: PASSWORD, totpSecret: secret, getStatus: async () => ({}), revokeClient: () => {}, now: () => s.clock.now }));
  const server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const client = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const code = totp(secret, { now: s.clock.now });
    assert.ok(s.approve(client, { code }).redirected);
    const login = await fetch(`http://127.0.0.1:${server.address().port}/status/login`, { method: 'POST', body: new URLSearchParams({ password: PASSWORD, code }), redirect: 'manual' });
    assert.equal(login.status, 401);
  } finally { server.close(); s.cleanup(); }
});

test('a wrong password doesn\'t use up the real code', async () => {
  const secret = generateSecret();
  const s = setup({ totpSecret: secret });
  try {
    const app = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const code = totp(secret, { now: s.clock.now });
    s.approve(app, { password: 'nope', code });
    assert.ok(s.approve(app, { code }).redirected);
  } finally { s.cleanup(); }
});

test('reusing an old refresh token signs that sign-in out', async () => {
  const s = setup();
  try {
    const app = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const first = await s.signIn(app);
    const second = await s.auth.provider.exchangeRefreshToken(app, first.refresh_token);
    await assert.rejects(s.auth.provider.exchangeRefreshToken(app, first.refresh_token), /invalid/i);
    await assert.rejects(s.auth.provider.exchangeRefreshToken(app, second.refresh_token), /invalid/i, 'the newer refresh token stops working too');
    await assert.rejects(s.auth.provider.verifyAccessToken(second.access_token), /invalid/i, 'and so does its access token');

    const other = await s.signIn(app);
    await s.auth.provider.verifyAccessToken(other.access_token); // a separate sign-in of the same app is untouched
  } finally { s.cleanup(); }
});

test('only the scope this server has is granted', async () => {
  const s = setup();
  try {
    const app = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const odd = await s.signIn(app, { scope: 'anything at-all' });
    assert.ok(!String(odd.scope || '').includes('anything'));
    const normal = await s.signIn(app, { scope: 'canvas' });
    assert.equal(normal.scope, 'canvas');
    const refreshed = await s.auth.provider.exchangeRefreshToken(app, normal.refresh_token, ['canvas', 'admin']);
    assert.equal(refreshed.scope, 'canvas', 'a refresh never adds scopes');
  } finally { s.cleanup(); }
});

test('a token meant for another server is refused, and old tokens without one still work', async () => {
  const s = setup();
  try {
    const app = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const res = s.approve(app, { resource: 'https://other.example/mcp' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.redirected, null);

    const mine = await s.signIn(app, { resource: RESOURCE });
    assert.equal(String((await s.auth.provider.verifyAccessToken(mine.access_token)).resource), RESOURCE);
    const unnamed = await s.signIn(app);
    assert.equal(String((await s.auth.provider.verifyAccessToken(unnamed.access_token)).resource), RESOURCE, 'a sign-in without one is for this server');

    const store = JSON.parse(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'));
    store.accessTokens.foreign = { clientId: app.client_id, scopes: [], resource: 'https://other.example/mcp', expiresAt: Math.floor(s.clock.now / 1000) + 3600 };
    store.accessTokens.legacy = { clientId: app.client_id, scopes: [], expiresAt: Math.floor(s.clock.now / 1000) + 3600 };
    fs.writeFileSync(path.join(s.dir, 'store.json'), JSON.stringify(store));
    await assert.rejects(s.auth.provider.verifyAccessToken('foreign'), /not issued for this server/i);
    await s.auth.provider.verifyAccessToken('legacy');
    await assert.rejects(s.auth.provider.exchangeRefreshToken(app, mine.refresh_token, undefined, new URL('https://other.example/mcp')), /server/i);
  } finally { s.cleanup(); }
});

test('a code only works with the return address it was sent to', async () => {
  const s = setup();
  try {
    const app = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const code = s.codeFrom(s.approve(app));
    await assert.rejects(s.auth.provider.exchangeAuthorizationCode(app, code, undefined, 'https://somewhere.else/cb'), /redirect|return address/i);
    const again = s.codeFrom(s.approve(app));
    assert.ok((await s.auth.provider.exchangeAuthorizationCode(app, again, undefined, 'https://claude.ai/api/mcp/auth_callback')).access_token);
    const bare = s.codeFrom(s.approve(app));
    assert.ok((await s.auth.provider.exchangeAuthorizationCode(app, bare)).access_token, 'apps that leave it out still work');
  } finally { s.cleanup(); }
});

test('an app on this computer can come back on any port, like the SDK allows', async () => {
  const s = setup();
  try {
    const app = s.register({ client_name: 'native', redirect_uris: ['http://127.0.0.1:1234/cb'] });
    const otherPort = s.approve(app, { redirect_uri: 'http://127.0.0.1:5555/cb' });
    assert.equal(new URL(otherPort.redirected).port, '5555');
    assert.equal(s.approve(app, { redirect_uri: 'http://127.0.0.1:5555/other' }).statusCode, 400, 'the path still has to match');
    assert.equal(s.approve(app, { redirect_uri: 'http://localhost:5555/cb' }).statusCode, 400, 'and so does the host');
    const site = s.register({ client_name: 'site', redirect_uris: ['https://site.example:8443/cb'] });
    assert.equal(s.approve(site, { redirect_uri: 'https://site.example:9443/cb' }).statusCode, 400, 'a website\'s port has to match exactly');
  } finally { s.cleanup(); }
});

test('codes and wrong-password counts don\'t pile up in memory', async () => {
  const s = setup();
  try {
    const app = s.register({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    for (let i = 0; i < 300; i++) s.approve(app, i % 2 ? { password: 'nope' } : {});
    assert.ok(s.auth.pending().codes >= 150 && s.auth.pending().addresses > 0);
    s.clock.now += 16 * 60000;
    s.approve(app, { password: 'nope' });
    s.approve(app);
    assert.deepEqual(s.auth.pending(), { codes: 1, addresses: 1 }, 'only the newest code and address are left');
  } finally { s.cleanup(); }
});

test('error pages from the sign-in form aren\'t cached', async () => {
  const s = setup();
  try {
    const res = fakeRes();
    s.auth.approveHandler({ ip: '198.51.100.7', body: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally { s.cleanup(); }
});
