/**
 * Minimal single-user OAuth 2.1 authorization server for the Canvas MCP
 * server. Exists only so remote clients (desktop/mobile/web MCP clients via
 * Custom Connector) can prove they know the one password before touching
 * your Canvas token. Not a multi-tenant identity system: one password,
 * gates every client that completes the flow.
 *
 * Clients and refresh/access tokens persist to a JSON store file so a
 * server restart doesn't force every connected device to re-authenticate.
 * The store is read fresh from disk on every lookup and written through on
 * every change (no in-memory cache across calls) — this is what lets
 * supervisor.js hand this file between two machines (see its own header
 * comment) without either one ever operating on a stale in-memory copy.
 * Authorization codes are short-lived and kept in memory only — a login
 * only ever happens against whichever machine is currently live, so they
 * don't need to cross machines.
 *
 * Also here: the list of signed-in apps (with sign-out), clean-up of apps that
 * never finished signing in, a per-address lockout after wrong passwords, a
 * login history, and optional two-factor codes (CANVAS_MCP_TOTP_SECRET).
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { verifyTotp } from './totp.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour; clients refresh via refresh_token
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LAST_USED_EVERY_MS = 5 * 60 * 1000; // record "last used" at most this often, so every request isn't a disk write
const LOCK_AFTER = 5; // wrong tries from one address...
const LOCK_WINDOW_MS = 15 * 60 * 1000; // ...within this window lock that address out for the same time
const HISTORY_MAX = 200;

function readStore(storePath) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return { clients: data.clients || {}, refreshTokens: data.refreshTokens || {}, accessTokens: data.accessTokens || {} };
  } catch {
    return { clients: {}, refreshTokens: {}, accessTokens: {} };
  }
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Same-length digests compared in constant time, so response timing says nothing about the password. */
export function passwordMatches(entered, password) {
  const a = crypto.createHash('sha256').update(String(entered ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(password ?? '')).digest();
  return Boolean(password) && crypto.timingSafeEqual(a, b);
}

export function renderLoginPage({ clientId, clientName, redirectUri, state, codeChallenge, resource, scope, error, totp }) {
  const app = clientName ? escapeHtml(clientName) : 'An app';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Connect to Canvas</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1a1d21;--muted:#5f6670;--line:#d9dde3;--accent:#c0392b;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1f2226;--text:#eceef1;--muted:#a3a9b1;--line:#353a40;--accent:#e2574c;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:380px;width:100%}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted)}label{display:block;font-size:14px;margin:12px 0 6px}
input{width:100%;padding:11px 12px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
button{width:100%;margin-top:18px;padding:12px;font-size:16px;font-weight:600;cursor:pointer;border-radius:8px;border:0;background:var(--accent);color:#fff}
.error{color:var(--err);font-size:14px;margin:0 0 8px}.small{font-size:13px;margin-top:16px}
</style></head>
<body><main>
<h1>Connect to your Canvas</h1>
<p><b>${app}</b> wants to use your Canvas through your own server. Enter the password you chose when you set it up.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="POST" action="/authorize/approve">
<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state || '')}">
<input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
<input type="hidden" name="resource" value="${escapeHtml(resource || '')}">
<input type="hidden" name="scope" value="${escapeHtml(scope || '')}">
<label for="password">Password</label>
<input id="password" type="password" name="password" autocomplete="current-password" autofocus required>
${totp ? '<label for="code">Code from your authenticator app</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" required>' : ''}
<button type="submit">Connect</button>
</form>
<p class="small">Didn't start this? Close this page. Nothing connects without your password.</p>
</main></body></html>`;
}

export function createOAuthProvider({ password, storePath, historyPath = null, totpSecret = '', onLogin = () => {}, now = () => Date.now() }) {
  const authCodes = new Map();
  const failures = new Map(); // ip -> { times: [ms], lockedUntil: ms }

  const persist = (store) => {
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, storePath);
  };

  function issueTokens(clientId, scopes, resource) {
    const store = readStore(storePath);
    const access_token = randomToken();
    const refresh_token = randomToken();
    const expiresAt = Math.floor(now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    store.accessTokens[access_token] = { clientId, scopes: scopes || [], resource, expiresAt };
    store.refreshTokens[refresh_token] = { clientId, scopes: scopes || [], resource, issuedAt: new Date(now()).toISOString() };
    if (store.clients[clientId]) store.clients[clientId].last_used_at = new Date(now()).toISOString();
    persist(store);
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token, scope: (scopes || []).join(' ') || undefined };
  }

  function recordLogin(entry) {
    if (!historyPath) return;
    let list = [];
    try { list = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch { /* first entry */ }
    list.push({ at: new Date(now()).toISOString(), ...entry });
    try { fs.writeFileSync(historyPath, JSON.stringify(list.slice(-HISTORY_MAX), null, 2)); } catch { /* read-only folder */ }
  }

  function lockedFor(ip) {
    const f = failures.get(ip);
    return f && f.lockedUntil > now() ? Math.ceil((f.lockedUntil - now()) / 60000) : 0;
  }
  function noteFailure(ip) {
    const f = failures.get(ip) || { times: [], lockedUntil: 0 };
    f.times = [...f.times.filter((t) => t > now() - LOCK_WINDOW_MS), now()];
    if (f.times.length >= LOCK_AFTER) { f.lockedUntil = now() + LOCK_WINDOW_MS; f.times = []; }
    failures.set(ip, f);
    return f.lockedUntil > now();
  }

  const provider = {
    clientsStore: {
      getClient(clientId) {
        return readStore(storePath).clients[clientId];
      },
      registerClient(client) {
        const store = readStore(storePath);
        const client_id = crypto.randomUUID();
        const full = { ...client, client_id, client_id_issued_at: Math.floor(now() / 1000) };
        store.clients[client_id] = full;
        persist(store);
        return full;
      },
    },

    async authorize(client, params, res) {
      res.set('Content-Type', 'text/html');
      res.send(renderLoginPage({
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUri: params.redirectUri,
        state: params.state,
        codeChallenge: params.codeChallenge,
        resource: params.resource ? params.resource.toString() : '',
        scope: (params.scopes || []).join(' '),
        totp: Boolean(totpSecret),
      }));
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const entry = authCodes.get(authorizationCode);
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      return entry.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode) {
      const entry = authCodes.get(authorizationCode);
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      authCodes.delete(authorizationCode); // one-time use
      if (entry.expiresAt < now()) throw new InvalidGrantError('Authorization code expired');
      return issueTokens(client.client_id, entry.scopes, entry.resource);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const store = readStore(storePath);
      const entry = store.refreshTokens[refreshToken];
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
      delete store.refreshTokens[refreshToken]; // rotate on use
      persist(store);
      return issueTokens(client.client_id, scopes && scopes.length ? scopes : entry.scopes, resource ? resource.toString() : entry.resource);
    },

    async verifyAccessToken(token) {
      const store = readStore(storePath);
      const entry = store.accessTokens[token];
      if (!entry) throw new InvalidTokenError('Invalid access token');
      if (entry.expiresAt < Math.floor(now() / 1000)) {
        delete store.accessTokens[token];
        persist(store);
        throw new InvalidTokenError('Access token expired');
      }
      const client = store.clients[entry.clientId];
      if (client && (!client.last_used_at || now() - Date.parse(client.last_used_at) > LAST_USED_EVERY_MS)) {
        client.last_used_at = new Date(now()).toISOString();
        persist(store);
      }
      return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: entry.expiresAt, resource: entry.resource ? new URL(entry.resource) : undefined };
    },

    async revokeToken(_client, request) {
      const store = readStore(storePath);
      delete store.accessTokens[request.token];
      delete store.refreshTokens[request.token];
      persist(store);
    },
  };

  /** Apps that have signed in (or tried to), most recently used first. */
  function listSessions() {
    const store = readStore(storePath);
    const nowSec = Math.floor(now() / 1000);
    return Object.values(store.clients).map((c) => {
      const access = Object.values(store.accessTokens).filter((t) => t.clientId === c.client_id && t.expiresAt > nowSec).length;
      const refresh = Object.values(store.refreshTokens).filter((t) => t.clientId === c.client_id).length;
      return {
        client_id: c.client_id,
        app: c.client_name || 'Unnamed app',
        registered: c.client_id_issued_at ? new Date(c.client_id_issued_at * 1000).toISOString() : null,
        last_used: c.last_used_at || null,
        signed_in: access + refresh > 0,
      };
    }).sort((a, b) => Date.parse(b.last_used || b.registered || 0) - Date.parse(a.last_used || a.registered || 0));
  }

  /** Sign one app out: its client record and every token it holds. */
  function revokeClient(clientId) {
    const store = readStore(storePath);
    if (!store.clients[clientId]) return false;
    delete store.clients[clientId];
    for (const [k, t] of Object.entries(store.accessTokens)) if (t.clientId === clientId) delete store.accessTokens[k];
    for (const [k, t] of Object.entries(store.refreshTokens)) if (t.clientId === clientId) delete store.refreshTokens[k];
    persist(store);
    return true;
  }

  /** Sign every app out (used after the password changes). */
  function revokeAll() {
    const count = Object.keys(readStore(storePath).clients).length;
    persist({ clients: {}, refreshTokens: {}, accessTokens: {} });
    return count;
  }

  /**
   * Tidy the store: expired access tokens, apps that registered but never finished signing in (after a week), and
   * apps nobody has used for `unusedDays` (90 by default).
   */
  function prune({ unusedDays = 90, emptyDays = 7 } = {}) {
    const store = readStore(storePath);
    const nowSec = Math.floor(now() / 1000);
    let tokens = 0, apps = 0, stamped = 0;
    for (const [k, t] of Object.entries(store.accessTokens)) if (t.expiresAt < nowSec) { delete store.accessTokens[k]; tokens++; }
    for (const c of Object.values(store.clients)) {
      const hasTokens = Object.values(store.refreshTokens).some((t) => t.clientId === c.client_id) || Object.values(store.accessTokens).some((t) => t.clientId === c.client_id);
      // Apps signed in before 1.3.0 have no "last used" date. Start their clock now instead of judging them by when
      // they registered, so updating never signs out an app that is still in use.
      if (hasTokens && !c.last_used_at) { c.last_used_at = new Date(now()).toISOString(); stamped++; continue; }
      const lastSeen = c.last_used_at ? Date.parse(c.last_used_at) / 1000 : c.client_id_issued_at || nowSec;
      const stale = hasTokens ? nowSec - lastSeen > unusedDays * 86400 : nowSec - (c.client_id_issued_at || nowSec) > emptyDays * 86400;
      if (!stale) continue;
      delete store.clients[c.client_id];
      for (const [k, t] of Object.entries(store.refreshTokens)) if (t.clientId === c.client_id) delete store.refreshTokens[k];
      for (const [k, t] of Object.entries(store.accessTokens)) if (t.clientId === c.client_id) delete store.accessTokens[k];
      apps++;
    }
    if (tokens || apps || stamped) persist(store);
    return { removed_apps: apps, removed_tokens: tokens };
  }

  function loginHistory(limit = 20) {
    try { return JSON.parse(fs.readFileSync(historyPath, 'utf8')).slice(-limit).reverse(); } catch { return []; }
  }

  // Mounted separately at POST /authorize/approve: the login form's submit target.
  function approveHandler(req, res) {
    const { client_id, redirect_uri, state, code_challenge, resource, scope, password: entered, code } = req.body || {};
    const client = provider.clientsStore.getClient(client_id);
    if (!client || !redirect_uri || !code_challenge) {
      res.status(400).send('Malformed authorization request.');
      return;
    }
    if (Array.isArray(client.redirect_uris) && client.redirect_uris.length && !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).send('That return address does not belong to this app.');
      return;
    }
    const ip = req.ip;
    const page = (error, status) => {
      res.set('Content-Type', 'text/html');
      res.status(status).send(renderLoginPage({ clientId: client_id, clientName: client.client_name, redirectUri: redirect_uri, state, codeChallenge: code_challenge, resource, scope, error, totp: Boolean(totpSecret) }));
    };
    const minutes = lockedFor(ip);
    if (minutes) {
      page(`Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 429);
      return;
    }
    const passOk = passwordMatches(entered, password);
    const codeOk = !totpSecret || verifyTotp(totpSecret, code, { now: now() });
    if (!passOk || !codeOk) {
      const reason = !passOk ? 'wrong password' : 'wrong two-factor code';
      console.error(`[oauth] failed login attempt from ${ip} (${reason})`);
      const locked = noteFailure(ip);
      recordLogin({ ip, ok: false, app: client.client_name || null, reason });
      onLogin({ ok: false, ip, app: client.client_name, reason, locked });
      page(locked ? 'Too many wrong tries. This address is locked out for 15 minutes.' : !passOk ? 'Incorrect password.' : 'That code is wrong or expired. Use the newest code from your authenticator app.', locked ? 429 : 401);
      return;
    }
    failures.delete(ip);
    recordLogin({ ip, ok: true, app: client.client_name || null });
    onLogin({ ok: true, ip, app: client.client_name });
    const authCode = randomToken();
    authCodes.set(authCode, {
      clientId: client_id,
      codeChallenge: code_challenge,
      resource: resource || undefined,
      scopes: scope ? scope.split(' ').filter(Boolean) : [],
      expiresAt: now() + AUTH_CODE_TTL_MS,
    });
    const redirect = new URL(redirect_uri);
    redirect.searchParams.set('code', authCode);
    if (state) redirect.searchParams.set('state', state);
    res.redirect(redirect.toString());
  }

  return { provider, approveHandler, listSessions, revokeClient, revokeAll, prune, loginHistory };
}
