// The status page's own sign-in: Lock really signs you out, a copied cookie can't outlive it, and wrong passwords are
// logged and locked out like on the login page. A real Express router on a random loopback port; fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createOAuthProvider } from '../oauth-provider.js';
import { createStatusRouter, dashboardPage } from '../status-page.js';

const PASSWORD = 'status-pass-123456';
const status = async () => ({ hostname: 'study-pc', sessions: [] });

/** A status page on a random port. With `auth`, sign-in goes through the provider's lockout and history. */
async function serve({ auth } = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.use('/status', createStatusRouter({ password: PASSWORD, getStatus: status, revokeClient: () => {}, ...(auth ? { checkPassword: auth.passwordAttempt } : {}) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/status`;
  const login = (password, from = '198.51.100.20') => fetch(`${base}/login`, { method: 'POST', headers: { 'X-Forwarded-For': from }, body: new URLSearchParams({ password }), redirect: 'manual' });
  const view = async (cookie) => (await fetch(base, { headers: cookie ? { cookie } : {} })).text();
  const lock = (cookie) => fetch(`${base}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  return { base, login, view, lock, close: () => server.close() };
}
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
const signedIn = (html) => /Canvas server status<\/h1><form method="POST" action="\/status\/logout"/.test(html);

test('the status page shows which tool profile is on and how many tools that is', () => {
  const html = dashboardPage({ hostname: 'study-pc', version: '1.5.0', tools: 36, profile: 'study', profile_title: 'Study and planning <b>', sessions: [] }, 'csrf');
  assert.match(html, /<dt>Tools<\/dt><dd>Study and planning &lt;b&gt; \(36\)/);
  assert.match(dashboardPage({ hostname: 'pc', version: '1.4.1', tools: 237, sessions: [] }, 'csrf'), /<dt>Tools<\/dt><dd>Everything \(237\)/, 'an older server that sends no profile has every tool');
});

test('Lock signs that session out everywhere, not just in this browser', async () => {
  const s = await serve();
  try {
    const cookie = cookieOf(await s.login(PASSWORD));
    assert.ok(signedIn(await s.view(cookie)));
    const copy = cookie; // as if someone had copied it
    await s.lock(cookie);
    assert.ok(!signedIn(await s.view(copy)), 'the copied cookie stops working when you lock');
  } finally { s.close(); }
});

test('a session cookie is a random ID, not something the password can rebuild', async () => {
  const s = await serve();
  const t = await serve();
  try {
    const a = cookieOf(await s.login(PASSWORD));
    const b = cookieOf(await s.login(PASSWORD));
    assert.notEqual(a, b);
    assert.ok(!/\d{13}\./.test(a), 'no expiry time and signature in the cookie');
    assert.ok(!signedIn(await t.view(a)), 'a cookie from one server is no good on another with the same password');
  } finally { s.close(); t.close(); }
});

test('wrong status-page passwords are logged and lock the address out, like the login page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-status-'));
  const events = [];
  const auth = createOAuthProvider({ password: PASSWORD, storePath: path.join(dir, 'store.json'), historyPath: path.join(dir, 'history.json'), onLogin: (e) => events.push(e) });
  const s = await serve({ auth });
  try {
    for (let i = 0; i < 5; i++) assert.notEqual((await s.login('nope', '198.51.100.30')).status, 303);
    const locked = await s.login(PASSWORD, '198.51.100.30');
    assert.equal(locked.status, 429, 'locked even with the right password');
    assert.match(await locked.text(), /Too many wrong tries/);
    const history = auth.loginHistory(20);
    assert.equal(history.filter((h) => !h.ok && h.app === 'Status page').length, 5);
    assert.ok(events.some((e) => e.locked), 'the lockout reaches phone alerts');
    assert.equal((await s.login(PASSWORD, '198.51.100.31')).status, 303, 'another address still signs in');
    assert.ok(auth.loginHistory(1)[0].ok);
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
