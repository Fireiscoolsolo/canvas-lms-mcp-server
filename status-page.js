// The password-protected status page at /status on your public address: whether the server is online and which
// computer is serving, the Canvas connection and token expiry, signed-in apps (with sign-out), recent sign-ins,
// the computers in your group, phone-alert settings and recent problems. Nothing secret is ever shown.
import crypto from 'node:crypto';
import express from 'express';
import { passwordMatches } from './oauth-provider.js';
import { acceptTotp } from './totp.js';

const COOKIE = 'canvas_status';
const SESSION_MS = 12 * 3600000;
const MAX_SESSIONS = 50;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `:root{--bg:#f6f7f9;--card:#fff;--text:#1a1d21;--muted:#5f6670;--line:#d9dde3;--accent:#c0392b;--ok:#1e7d43;--warn:#9a6700;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1f2226;--text:#eceef1;--muted:#a3a9b1;--line:#353a40;--accent:#e2574c;--ok:#5cc98a;--warn:#e3b341;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{max-width:860px;margin:0 auto}h1{font-size:22px;margin:8px 0 16px}h2{font-size:16px;margin:0 0 10px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 14px}
dl{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 6px;border-top:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;border-top:0}
.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}.muted{color:var(--muted)}
button{padding:6px 12px;border-radius:7px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;font:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;width:100%;padding:11px;font-weight:600}
input{width:100%;padding:10px 12px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;margin:4px 0 10px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px}.wrap{overflow-x:auto}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;margin:0}
@media (max-width:600px){dl{grid-template-columns:1fr}dt{margin-top:6px}}`;

// The page's only script, kept apart from the data so an app name can only ever be text. App names come from open
// registration, so anyone on the internet can choose one. The browser runs nothing else: see STATUS_CSP.
const SIGN_OUT_PROMPT = "document.addEventListener('submit',function(e){var a=e.target.getAttribute('data-app');if(a!==null&&!confirm('Sign '+a+' out? It will need the password again.'))e.preventDefault()});";

export const STATUS_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${crypto.createHash('sha256').update(SIGN_OUT_PROMPT).digest('base64')}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

const page = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;

export function loginPage({ error, totp }) {
  return page('Canvas server status', `<section style="max-width:380px;margin:12vh auto">
<h1>Canvas server status</h1><p class="muted">Enter your server password to see how it is doing.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="POST" action="/status/login"><label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" autofocus required>
${totp ? '<label for="c">Code from your authenticator app</label><input id="c" name="code" inputmode="numeric" autocomplete="one-time-code" required>' : ''}
<button class="primary" type="submit">Show status</button></form></section>`);
}

export function dashboardPage(s, csrf, fmt = (t) => (t ? new Date(t).toLocaleString() : '')) {
  const days = s.token?.days_left;
  const tokenLine = days === undefined || days === null ? '<span class="muted">expiry unknown (your school hides it)</span>'
    : days < 0 ? '<span class="err">expired</span>' : `<span class="${days <= 7 ? 'warn' : 'ok'}">expires ${esc(fmt(s.token.expires_at))} (${days} day${days === 1 ? '' : 's'})</span>`;
  const sessions = (s.sessions || []).map((x) => `<tr><td>${esc(x.app)}</td><td>${x.signed_in ? '<span class="ok">signed in</span>' : '<span class="muted">not signed in</span>'}</td><td>${esc(fmt(x.last_used || x.registered)) || '<span class="muted">never</span>'}</td>
<td><form method="POST" action="/status/sessions/${encodeURIComponent(x.client_id)}/sign-out" data-app="${esc(x.app)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Sign out</button></form></td></tr>`).join('');
  const logins = (s.logins || []).map((l) => `<tr><td>${esc(fmt(l.at))}</td><td>${l.ok ? '<span class="ok">signed in</span>' : `<span class="err">${esc(l.reason || 'failed')}</span>`}</td><td>${esc(l.app || '')}</td><td>${esc(l.ip || '')}</td></tr>`).join('');
  const cluster = (s.cluster || []).map((m) => `<tr><td>${esc(m.hostname)}${m.self ? ' <span class="muted">(this one)</span>' : ''}</td><td>${m.state === 'active' ? '<span class="ok">serving</span>' : esc(m.state)}</td><td>${esc(m.version || '')}</td><td>${esc(fmt(m.last_seen))}</td></tr>`).join('');
  const a = s.alerts || {};
  return page('Canvas server status', `<div class="top"><h1>Canvas server status</h1><form method="POST" action="/status/logout"><button type="submit">Lock</button></form></div>
<section><h2>Server</h2><dl>
<dt>Status</dt><dd><span class="ok">Online</span>, served by <b>${esc(s.hostname)}</b></dd>
<dt>Address</dt><dd>${esc(s.public_url)}</dd>
<dt>Version</dt><dd>${esc(s.version)}</dd>
<dt>Tools</dt><dd>${esc(s.profile_title || 'Everything')} (${esc(s.tools)})</dd>
<dt>Running since</dt><dd>${esc(fmt(s.started_at))} (${esc(s.uptime)})</dd>
<dt>Tunnel</dt><dd>${esc(s.tunnel)}</dd></dl></section>
<section><h2>Canvas</h2><dl>
<dt>School</dt><dd>${esc(s.base_url || 'not set')}</dd>
<dt>Signed in as</dt><dd>${s.canvas_user ? esc(s.canvas_user) : '<span class="err">not connected</span>'}</dd>
<dt>Token</dt><dd>${tokenLine}</dd></dl></section>
<section id="apps"><h2>Signed-in apps</h2>${sessions ? `<div class="wrap"><table><tr><th>App</th><th>State</th><th>Last used</th><th></th></tr>${sessions}</table></div>` : '<p class="muted">No apps have connected yet.</p>'}
<p class="muted">Apps that never finished signing in are removed after a week, and apps unused for 90 days are signed out.</p></section>
<section><h2>Recent sign-ins</h2>${logins ? `<div class="wrap"><table><tr><th>When</th><th>Result</th><th>App</th><th>From</th></tr>${logins}</table></div>` : '<p class="muted">None yet.</p>'}</section>
<section><h2>Computers</h2>${cluster ? `<div class="wrap"><table><tr><th>Computer</th><th>Role</th><th>Version</th><th>Last heard from</th></tr>${cluster}</table></div>` : '<p class="muted">Only this computer.</p>'}</section>
<section><h2>Phone alerts</h2><dl>
<dt>Alerts</dt><dd>${a.on ? `<span class="ok">on</span> via ${esc((a.channels || []).join(', '))}` : '<span class="muted">off</span>'}</dd>
${a.on ? `<dt>About</dt><dd>${esc((a.types || []).join(', '))}</dd><dt>Checks</dt><dd>every ${esc(a.every_minutes)} minutes</dd>
${a.digest ? `<dt>Daily digest</dt><dd>${esc(a.digest)}</dd>` : ''}${a.quiet ? `<dt>Quiet hours</dt><dd>${esc(a.quiet)}</dd>` : ''}` : ''}</dl></section>
<section><h2>Recent problems</h2>${(s.problems || []).length ? `<pre>${s.problems.map((p) => `${esc(fmt(p.at))}  ${esc(p.line)}`).join('\n')}</pre>` : '<p class="muted">Nothing has gone wrong recently.</p>'}</section>`, SIGN_OUT_PROMPT);
}

/**
 * Express router for /status. getStatus() returns the dashboard data; revokeClient(id) signs an app out.
 * checkPassword(ip, password, code) decides a sign-in and returns { ok } or { ok, status, message }; the server passes
 * the login page's, so both share one lockout and one login history.
 * The page remembers you for 12 hours with a random session ID held in memory, so Lock ends it everywhere and a
 * restart ends them all. Sign-out buttons carry a CSRF token.
 */
export function createStatusRouter({ password, totpSecret = '', getStatus, revokeClient, limiter, fmt, checkPassword, now = () => Date.now() }) {
  const check = checkPassword || ((_ip, entered, code) => (passwordMatches(entered, password) && (!totpSecret || acceptTotp(totpSecret, code, { now: now() }))
    ? { ok: true } : { ok: false, status: 401, message: 'That password (or code) is wrong.' }));
  const key = crypto.randomBytes(32); // for CSRF tokens only; new on every start
  const sessions = new Map(); // id -> expires (ms)
  const sign = (v) => crypto.createHmac('sha256', key).update(v).digest('base64url');
  const read = (req) => (String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`)) || '').slice(COOKIE.length + 1);
  const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const authed = (req) => {
    const id = read(req);
    const expires = id ? sessions.get(id) : undefined;
    if (expires && expires <= now()) sessions.delete(id);
    return Boolean(expires && expires > now());
  };
  const startSession = () => {
    for (const [id, expires] of sessions) if (expires <= now()) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value); // the oldest goes first
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, now() + SESSION_MS);
    return id;
  };
  const csrf = (req) => sign(`csrf:${read(req)}`);
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/status; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': STATUS_CSP, 'Referrer-Policy': 'no-referrer' }); next(); });

  router.get('/', async (req, res) => {
    if (!authed(req)) return res.type('html').send(loginPage({ totp: Boolean(totpSecret) }));
    res.type('html').send(dashboardPage(await getStatus(), csrf(req), fmt));
  });
  router.post('/login', limiter || ((_q, _s, next) => next()), (req, res) => {
    const attempt = check(req.ip, req.body?.password, req.body?.code, 'Status page');
    if (!attempt.ok) return res.status(attempt.status || 401).type('html').send(loginPage({ error: attempt.message, totp: Boolean(totpSecret) }));
    res.set('Set-Cookie', cookie(startSession(), SESSION_MS / 1000));
    res.redirect(303, '/status');
  });
  router.post('/logout', (req, res) => {
    sessions.delete(read(req));
    res.set('Set-Cookie', cookie('', 0));
    res.redirect(303, '/status');
  });
  router.post('/sessions/:id/sign-out', (req, res) => {
    if (!authed(req) || !same(req.body?.csrf, csrf(req))) return res.status(403).type('html').send(page('Expired', '<section><p>This page expired. <a href="/status">Reload it</a> and try again.</p></section>'));
    revokeClient(req.params.id);
    res.redirect(303, '/status#apps');
  });
  return router;
}
