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
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour; clients refresh via refresh_token
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

function renderLoginPage({ clientId, redirectUri, state, codeChallenge, resource, scope, error }) {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Canvas MCP</title>
<style>
body{font-family:system-ui,sans-serif;max-width:360px;margin:80px auto;padding:0 16px;color:#1a1a1a}
input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box;font-size:16px;border:1px solid #ccc;border-radius:6px}
button{width:100%;padding:10px;font-size:16px;cursor:pointer;border-radius:6px;border:none;background:#c0392b;color:#fff}
.error{color:#c00;font-size:14px}
</style></head>
<body>
<h2>Canvas MCP</h2>
<p>Enter your password to connect this device.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="POST" action="/authorize/approve">
<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state || '')}">
<input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
<input type="hidden" name="resource" value="${escapeHtml(resource || '')}">
<input type="hidden" name="scope" value="${escapeHtml(scope || '')}">
<input type="password" name="password" placeholder="Password" autofocus required>
<button type="submit">Connect</button>
</form>
</body></html>`;
}

export function createOAuthProvider({ password, storePath }) {
  const authCodes = new Map();

  const persist = (store) => fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

  function issueTokens(clientId, scopes, resource) {
    const store = readStore(storePath);
    const access_token = randomToken();
    const refresh_token = randomToken();
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    store.accessTokens[access_token] = { clientId, scopes: scopes || [], resource, expiresAt };
    store.refreshTokens[refresh_token] = { clientId, scopes: scopes || [], resource };
    persist(store);
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token, scope: (scopes || []).join(' ') || undefined };
  }

  const provider = {
    clientsStore: {
      getClient(clientId) {
        return readStore(storePath).clients[clientId];
      },
      registerClient(client) {
        const store = readStore(storePath);
        const client_id = crypto.randomUUID();
        const full = { ...client, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) };
        store.clients[client_id] = full;
        persist(store);
        return full;
      },
    },

    async authorize(client, params, res) {
      res.set('Content-Type', 'text/html');
      res.send(renderLoginPage({
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        state: params.state,
        codeChallenge: params.codeChallenge,
        resource: params.resource ? params.resource.toString() : '',
        scope: (params.scopes || []).join(' '),
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
      if (entry.expiresAt < Date.now()) throw new InvalidGrantError('Authorization code expired');
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
      if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
        delete store.accessTokens[token];
        persist(store);
        throw new InvalidTokenError('Access token expired');
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

  // Mounted separately at POST /authorize/approve: the login form's submit target.
  function approveHandler(req, res) {
    const { client_id, redirect_uri, state, code_challenge, resource, scope, password: entered } = req.body || {};
    const client = provider.clientsStore.getClient(client_id);
    if (!client || !redirect_uri || !code_challenge) {
      res.status(400).send('Malformed authorization request.');
      return;
    }
    if (entered !== password) {
      console.error(`[oauth] failed login attempt from ${req.ip}`);
      res.set('Content-Type', 'text/html');
      res.status(401).send(renderLoginPage({ clientId: client_id, redirectUri: redirect_uri, state, codeChallenge: code_challenge, resource, scope, error: 'Incorrect password.' }));
      return;
    }
    const code = randomToken();
    authCodes.set(code, {
      clientId: client_id,
      codeChallenge: code_challenge,
      resource: resource || undefined,
      scopes: scope ? scope.split(' ').filter(Boolean) : [],
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    const redirect = new URL(redirect_uri);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);
    res.redirect(redirect.toString());
  }

  return { provider, approveHandler };
}
