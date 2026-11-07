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
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { acceptTotp } from './totp.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour; clients refresh via refresh_token
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LAST_USED_EVERY_MS = 5 * 60 * 1000; // record "last used" at most this often, so every request isn't a disk write
const LOCK_AFTER = 5; // wrong tries from one address...
const LOCK_WINDOW_MS = 15 * 60 * 1000; // ...within this window lock that address out for the same time
const HISTORY_MAX = 200;
const MAX_CLIENTS = 100; // anyone can register, so old registrations that never signed in make room
const SCOPES = ['canvas']; // the only scope this server has; anything else asked for is left out
const USED_REFRESH_DAYS = 30; // how long a replaced refresh token is remembered, to spot it being used again
const USED_REFRESH_MAX = 2000;

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a return address matches one the app registered. Exact, except that an app on this computer may come back on
 * any port (RFC 8252 7.3), as the SDK's own /authorize check allows.
 */
export function sameRedirect(requested, registered) {
  if (requested === registered) return true;
  let a, b;
  try { a = new URL(requested); b = new URL(registered); } catch { return false; }
  if (!LOOPBACK.has(a.hostname) || !LOOPBACK.has(b.hostname)) return false;
  return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

// Apps people connect, by the address they come back to. Used only to word the sign-in page, never to refuse anyone.
const KNOWN_APPS = [
  { name: 'Claude', claims: /claude|anthropic/i, hosts: ['claude.ai', 'claude.com'] },
  { name: 'ChatGPT', claims: /chatgpt|openai/i, hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'] },
  { name: 'VS Code', claims: /vs ?code|visual studio code/i, hosts: ['vscode.dev', 'insiders.vscode.dev'] },
];
const onHost = (host, hosts) => hosts.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Where the code goes after the password, as HTML for the sign-in page. Someone who knows your address can register an
 * app called "Claude" that sends the code to their own site, so the page names the site and warns when it doesn't fit.
 */
export function describeReturn(clientName, redirectUri) {
  let u;
  try { u = new URL(redirectUri); } catch { return { where: 'an address this server can\'t read', alert: 'This app\'s return address can\'t be read. Don\'t continue.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { where: `an app on this device (${escapeHtml(u.protocol)}//)` };
  if (LOOPBACK.has(u.hostname)) return { where: 'an app on this computer' };
  const host = escapeHtml(u.host);
  const known = KNOWN_APPS.find((a) => onHost(u.hostname, a.hosts));
  const claimed = KNOWN_APPS.find((a) => a.claims.test(clientName || ''));
  if (claimed && claimed !== known) {
    return { where: host, alert: `This app calls itself ${claimed.name}, but it would send your sign-in to <b>${host}</b>, which isn't ${claimed.name}. Don't enter your password unless you're sure.` };
  }
  if (!known) return { where: host, note: `<b>${host}</b> isn't an app this server knows. Only continue if you just added this server to that app yourself.` };
  return { where: `${host} (${known.name})` };
}

/** Same server, whatever path: a token issued for another server's address is never good here. */
const forThisServer = (resource, resourceUrl) => {
  if (!resourceUrl || !resource) return true;
  try { return new URL(String(resource)).origin === new URL(resourceUrl).origin; } catch { return false; }
};

// The login page runs no scripts and can't be framed. No form-action rule: the form has to redirect back to the app.
const LOGIN_PAGE_HEADERS = {
  'Content-Type': 'text/html',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function readStore(storePath) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return { clients: data.clients || {}, refreshTokens: data.refreshTokens || {}, accessTokens: data.accessTokens || {}, usedRefreshTokens: data.usedRefreshTokens || {} };
  } catch {
    return { clients: {}, refreshTokens: {}, accessTokens: {}, usedRefreshTokens: {} };
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
  const back = describeReturn(clientName, redirectUri);
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
.warn{color:var(--text);border-left:3px solid var(--err);padding:8px 12px;background:rgba(179,38,30,.08);border-radius:6px}
.note{font-size:14px}
</style></head>
<body><main>
<h1>Connect to your Canvas</h1>
<p><b>${app}</b> wants to use your Canvas through your own server. Enter the password you chose when you set it up.</p>
<p>After you connect, you go back to <b>${back.where}</b>.</p>
${back.alert ? `<p class="warn" role="alert">${back.alert}</p>` : back.note ? `<p class="note">${back.note}</p>` : ''}
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

/**
 *   resourceUrl  this server's /mcp address. When set, a sign-in or token for another server's address is refused, and
 *                a sign-in that names none is recorded as being for this one.
 */
export function createOAuthProvider({ password, storePath, historyPath = null, totpSecret = '', resourceUrl = '', onLogin = () => {}, now = () => Date.now() }) {
  const authCodes = new Map();
  const failures = new Map(); // ip -> { times: [ms], lockedUntil: ms }

  const persist = (store) => {
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, storePath);
  };

  /** Drop codes that expired and addresses with no recent wrong tries, so a flood of attempts can't fill memory. */
  function sweep() {
    for (const [k, c] of authCodes) if (c.expiresAt < now()) authCodes.delete(k);
    for (const [k, f] of failures) if (f.lockedUntil <= now() && f.times.every((t) => t <= now() - LOCK_WINDOW_MS)) failures.delete(k);
  }

  /**
   * One sign-in's tokens. `family` ties every refresh of that sign-in together, so a stolen refresh token that is used
   * after the real app has moved on can sign the whole sign-in out.
   */
  function issueTokens(clientId, scopes, resource, family = crypto.randomUUID(), store = readStore(storePath)) {
    const access_token = randomToken();
    const refresh_token = randomToken();
    const expiresAt = Math.floor(now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    store.accessTokens[access_token] = { clientId, scopes: scopes || [], resource, expiresAt, family };
    store.refreshTokens[refresh_token] = { clientId, scopes: scopes || [], resource, issuedAt: new Date(now()).toISOString(), family };
    if (store.clients[clientId]) store.clients[clientId].last_used_at = new Date(now()).toISOString();
    persist(store);
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token, scope: (scopes || []).join(' ') || undefined };
  }

  /** Remove every token of one sign-in. */
  function dropFamily(store, family) {
    for (const [k, t] of Object.entries(store.accessTokens)) if (t.family === family) delete store.accessTokens[k];
    for (const [k, t] of Object.entries(store.refreshTokens)) if (t.family === family) delete store.refreshTokens[k];
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
        if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.length) {
          throw new InvalidClientMetadataError('An app needs at least one return address (redirect_uris) to sign in.');
        }
        const store = readStore(storePath);
        if (Object.keys(store.clients).length >= MAX_CLIENTS) {
          const holding = new Set([...Object.values(store.refreshTokens), ...Object.values(store.accessTokens)].map((t) => t.clientId));
          const spare = Object.values(store.clients).filter((c) => !holding.has(c.client_id)).sort((a, b) => (a.client_id_issued_at || 0) - (b.client_id_issued_at || 0));
          while (Object.keys(store.clients).length >= MAX_CLIENTS && spare.length) delete store.clients[spare.shift().client_id];
          if (Object.keys(store.clients).length >= MAX_CLIENTS) throw new InvalidClientMetadataError(`${MAX_CLIENTS} apps are already signed in to this server. Sign some out on the status page first.`);
        }
        const client_id = crypto.randomUUID();
        const full = { ...client, client_id, client_id_issued_at: Math.floor(now() / 1000) };
        store.clients[client_id] = full;
        persist(store);
        return full;
      },
    },

    async authorize(client, params, res) {
      res.set(LOGIN_PAGE_HEADERS);
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

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
      const entry = authCodes.get(authorizationCode);
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      authCodes.delete(authorizationCode); // one-time use
      if (entry.expiresAt < now()) throw new InvalidGrantError('Authorization code expired');
      // A code is only good with the return address it was sent to. Apps that leave the address out still work.
      if (redirectUri !== undefined && redirectUri !== entry.redirectUri) throw new InvalidGrantError('That code was sent to a different return address (redirect_uri).');
      if (resource && entry.resource && String(resource) !== entry.resource) throw new InvalidTargetError('That code was issued for a different server.');
      return issueTokens(client.client_id, entry.scopes, entry.resource);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const store = readStore(storePath);
      const entry = store.refreshTokens[refreshToken];
      if (!entry || entry.clientId !== client.client_id) {
        // A refresh token that was already replaced is being used again: either the app retried, or someone copied it.
        // Either way that sign-in can't be trusted any more, so all of its tokens stop working.
        const used = store.usedRefreshTokens[hashOf(refreshToken)];
        if (used && used.clientId === client.client_id) {
          dropFamily(store, used.family);
          persist(store);
          console.error(`[oauth] an old refresh token for ${client.client_name || client.client_id} was used again; that sign-in was signed out`);
        }
        throw new InvalidGrantError('Invalid refresh token');
      }
      if (resource && !forThisServer(resource, resourceUrl)) throw new InvalidTargetError('That token is for a different server.');
      delete store.refreshTokens[refreshToken]; // rotate on use
      const family = entry.family || crypto.randomUUID();
      store.usedRefreshTokens[hashOf(refreshToken)] = { clientId: client.client_id, family, at: new Date(now()).toISOString() };
      const used = Object.entries(store.usedRefreshTokens);
      if (used.length > USED_REFRESH_MAX) for (const [k] of used.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(0, used.length - USED_REFRESH_MAX)) delete store.usedRefreshTokens[k];
      // A refresh can keep or narrow the scopes, never add one.
      const granted = scopes && scopes.length ? scopes.filter((s) => entry.scopes.includes(s)) : entry.scopes;
      return issueTokens(client.client_id, granted, entry.resource || (resource ? resource.toString() : undefined), family, store);
    },

    async verifyAccessToken(token) {
      const store = readStore(storePath);
      const entry = store.accessTokens[token];
      if (!entry) throw new InvalidTokenError('Invalid access token');
      if (!forThisServer(entry.resource, resourceUrl)) throw new InvalidTokenError('That token was not issued for this server.');
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
      const resource = entry.resource || resourceUrl;
      return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: entry.expiresAt, resource: resource ? new URL(resource) : undefined };
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
    persist({ clients: {}, refreshTokens: {}, accessTokens: {}, usedRefreshTokens: {} });
    return count;
  }

  /**
   * Tidy the store: expired access tokens, apps that registered but never finished signing in (after a week), and
   * apps nobody has used for `unusedDays` (90 by default).
   */
  function prune({ unusedDays = 90, emptyDays = 7 } = {}) {
    const store = readStore(storePath);
    const nowSec = Math.floor(now() / 1000);
    let tokens = 0, apps = 0, stamped = 0, forgotten = 0;
    sweep();
    for (const [k, t] of Object.entries(store.accessTokens)) if (t.expiresAt < nowSec) { delete store.accessTokens[k]; tokens++; }
    for (const [k, u] of Object.entries(store.usedRefreshTokens)) if (now() - Date.parse(u.at) > USED_REFRESH_DAYS * 86400000) { delete store.usedRefreshTokens[k]; forgotten++; }
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
    if (tokens || apps || stamped || forgotten) persist(store);
    return { removed_apps: apps, removed_tokens: tokens };
  }

  function loginHistory(limit = 20) {
    try { return JSON.parse(fs.readFileSync(historyPath, 'utf8')).slice(-limit).reverse(); } catch { return []; }
  }

  // Mounted separately at POST /authorize/approve: the login form's submit target.
  function approveHandler(req, res) {
    const { client_id, redirect_uri, state, code_challenge, resource, scope, password: entered, code } = req.body || {};
    const client = client_id ? provider.clientsStore.getClient(client_id) : null;
    const refuse = (message) => { res.set(LOGIN_PAGE_HEADERS); res.status(400).send(message); };
    if (!client || !redirect_uri || !code_challenge) {
      refuse('Malformed authorization request.');
      return;
    }
    // Only an address the app registered. An app that registered none (possible before this check) can't sign in.
    if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.some((r) => sameRedirect(redirect_uri, r))) {
      refuse('That return address does not belong to this app.');
      return;
    }
    if (!forThisServer(resource, resourceUrl)) {
      refuse('This sign-in is for a different server.');
      return;
    }
    sweep();
    const ip = req.ip;
    const page = (error, status) => {
      res.set(LOGIN_PAGE_HEADERS);
      res.status(status).send(renderLoginPage({ clientId: client_id, clientName: client.client_name, redirectUri: redirect_uri, state, codeChallenge: code_challenge, resource, scope, error, totp: Boolean(totpSecret) }));
    };
    const minutes = lockedFor(ip);
    if (minutes) {
      page(`Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 429);
      return;
    }
    const passOk = passwordMatches(entered, password);
    // The code is only checked (and used up) after a right password, so a wrong guess never spends the real code.
    const codeOk = !totpSecret || (passOk && acceptTotp(totpSecret, code, { now: now() }));
    if (!passOk || !codeOk) {
      const reason = !passOk ? 'wrong password' : 'wrong or reused two-factor code';
      console.error(`[oauth] failed login attempt from ${ip} (${reason})`);
      const locked = noteFailure(ip);
      recordLogin({ ip, ok: false, app: client.client_name || null, reason });
      onLogin({ ok: false, ip, app: client.client_name, reason, locked });
      // With two-factor on, one message for both, so the page never says the password was right.
      const message = totpSecret ? 'The password or code is wrong. Use the newest code from your authenticator app.' : 'Incorrect password.';
      page(locked ? 'Too many wrong tries. This address is locked out for 15 minutes.' : message, locked ? 429 : 401);
      return;
    }
    failures.delete(ip);
    recordLogin({ ip, ok: true, app: client.client_name || null });
    onLogin({ ok: true, ip, app: client.client_name });
    const authCode = randomToken();
    authCodes.set(authCode, {
      clientId: client_id,
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      resource: resource || resourceUrl || undefined,
      scopes: scope ? scope.split(' ').filter((s) => SCOPES.includes(s)) : [],
      expiresAt: now() + AUTH_CODE_TTL_MS,
    });
    const redirect = new URL(redirect_uri);
    redirect.searchParams.set('code', authCode);
    if (state) redirect.searchParams.set('state', state);
    res.redirect(redirect.toString());
  }

  /** How many sign-in codes and addresses with wrong tries are held in memory (for tests and diagnostics). */
  const pending = () => ({ codes: authCodes.size, addresses: failures.size });

  return { provider, approveHandler, listSessions, revokeClient, revokeAll, prune, loginHistory, pending };
}
