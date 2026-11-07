#!/usr/bin/env node
/**
 * Canvas LMS MCP Server, Remote Edition
 * -------------------------------------
 * The same student tools as the Local Edition (they live in core/), served over Streamable HTTP so any device can
 * use them: an OAuth login gated by one password, a status page, download links, phone alerts, and the
 * /internal/* endpoints supervisor.js uses to run on several computers with failover.
 *
 * Config (environment variables, loaded from .env in the settings folder). See core/config.js for the Canvas ones:
 *   CANVAS_API_TOKEN, CANVAS_BASE_URL and the rest
 *   CANVAS_MCP_HOST      optional  HTTP bind host. Default: 127.0.0.1 (loopback only)
 *   CANVAS_MCP_PORT      optional  HTTP bind port. Default: 3939
 *   CANVAS_MCP_PUBLIC_URL optional Public HTTPS URL this server is reachable at (e.g. an
 *                                  ngrok domain). When set together with CANVAS_MCP_PASSWORD,
 *                                  enables OAuth so any device can connect, not just this PC.
 *   CANVAS_MCP_PASSWORD  optional  Password required once per device via the OAuth login page.
 *                                  No effect unless CANVAS_MCP_PUBLIC_URL is also set.
 *   CANVAS_MCP_TOTP_SECRET optional Turns on two-factor codes on the login and status pages
 *                                  (set it up with `canvas-lms-mcp-remote totp-setup`).
 *   CANVAS_MCP_OAUTH_STORE_PATH optional  Where OAuth clients/tokens persist. Default: ./oauth-store.json
 *   CANVAS_MCP_CLUSTER_SECRET optional  Shared secret protecting the /internal/* endpoints used by
 *                                  supervisor.js for active/standby handoff between two machines
 *                                  running this same server. Must be identical on both machines.
 *   CANVAS_MCP_TRUST_PROXY optional Which proxies to trust for the visitor's address (rate limits).
 *                                  Default: loopback. Docker setups use "uniquelocal".
 *   CANVAS_MCP_TRANSPORT optional  "stdio" (or the --stdio flag) serves over stdin/stdout instead of
 *                                  HTTP, for directories and sandboxes that inspect servers over
 *                                  stdio. No HTTP listener, OAuth or tunnel. Default: http
 *
 * Design notes:
 *   - Runs as a persistent local Streamable HTTP server so it stays available
 *     regardless of whether any MCP client is open. Reachable locally via the
 *     mcp-remote stdio<->HTTP bridge, and from any device via a public tunnel
 *     once CANVAS_MCP_PUBLIC_URL/CANVAS_MCP_PASSWORD are set (see oauth-provider.js).
 *   - Requests are stateless, so the app can't be asked a question mid-request: actions other people see use the
 *     confirm=true dry run here (stdio mode can ask the app directly).
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { createCanvasServer } from './core/index.js';
import { createOAuthProvider } from './oauth-provider.js';
import { startAlerts, alertSettings, describeAlerts } from './alerts.js';
import { createFileShare } from './file-share.js';
import { createStatusRouter } from './status-page.js';
import { startupProblems } from './startup-check.js';

// The MCP SDK's HTTP transport uses the global crypto, which Node 18 only has behind a flag.
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

dotenv.config({ quiet: true });

const DIR = process.cwd();
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const HOST = process.env.CANVAS_MCP_HOST || '127.0.0.1';
const PORT = Number(process.env.CANVAS_MCP_PORT || 3939);
const PUBLIC_URL = (process.env.CANVAS_MCP_PUBLIC_URL || '').replace(/\/+$/, '');
const MCP_PASSWORD = process.env.CANVAS_MCP_PASSWORD || '';
const AUTH_ENABLED = Boolean(PUBLIC_URL && MCP_PASSWORD);
const OAUTH_STORE_PATH = process.env.CANVAS_MCP_OAUTH_STORE_PATH || path.join(DIR, 'oauth-store.json');
const CLUSTER_SECRET = process.env.CANVAS_MCP_CLUSTER_SECRET || '';
const TOTP_SECRET = process.env.CANVAS_MCP_TOTP_SECRET || '';
const TRUST_PROXY = process.env.CANVAS_MCP_TRUST_PROXY || 'loopback';
const STDIO = process.argv.includes('--stdio') || process.env.CANVAS_MCP_TRANSPORT === 'stdio';
const START_TIME = new Date().toISOString();

// The last few hundred log lines (secrets already removed) feed "Recent problems" on the status page.
const recent = [];
const write = (line) => {
  process.stderr.write(`[canvas-mcp] ${line}\n`);
  recent.push({ at: new Date().toISOString(), line });
  if (recent.length > 300) recent.shift();
};

const files = AUTH_ENABLED ? createFileShare({ publicUrl: PUBLIC_URL }) : null;
const built = createCanvasServer({
  env: process.env,
  version: VERSION,
  defaultDownloadDir: path.join(DIR, 'canvas-downloads'),
  stateDir: DIR,
  log: write,
  elicitation: STDIO,
  ...(files ? { fileLink: files.link } : {}),
  secrets: [MCP_PASSWORD, CLUSTER_SECRET, TOTP_SECRET],
  missingTokenHelp: 'Add it to the .env file in your settings folder. On Windows, the free Canvas MCP Installer Assistant can set it up for you: https://fireiscoolsolo.github.io/canvas-lms-mcp-local/app/',
});
const { server, registry, cfg, tokenWatch } = built;
const log = built.log;

// Computers in the group, from their heartbeats (see supervisor.js). Forgotten after 10 quiet minutes.
const members = new Map();
function clusterList() {
  const self = { hostname: os.hostname(), state: 'active', version: VERSION, last_seen: new Date().toISOString(), self: true };
  const others = [...members.values()].filter((m) => Date.now() - Date.parse(m.last_seen) < 10 * 60000);
  return [self, ...others];
}

const humanDuration = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.floor(h / 24)} days`;
};

function readSupervisorState() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'supervisor-state.json'), 'utf8')); } catch { return null; }
}

async function main() {
  if (!STDIO) {
    const { errors, warnings } = startupProblems(process.env);
    for (const w of warnings) log(`WARNING: ${w}`);
    for (const e of errors) log(`Can't start: ${e.message}`);
    if (errors.length) { process.exitCode = 1; return; }
  }

  built.start();

  // stdio mode: lets directories and sandboxes that only speak stdio (for
  // example through mcp-proxy) start and inspect this server. Everything
  // below (HTTP listener, OAuth, handoff endpoints) is skipped.
  if (STDIO) {
    await server.connect(new StdioServerTransport());
    log('ready on stdio');
    return;
  }

  // Stateless Streamable HTTP: the SDK needs a fresh transport for every
  // request, and a server can only be connected to one transport at a time.
  // So every request gets its own server, with the same tools registered on
  // it (newServer() in core/index.js). They share one Canvas client, cache,
  // confirmation tokens and state, and Canvas calls still go out one at a
  // time, but a slow tool on one device never holds up a request from
  // another. When the app stops waiting, its server closes, and a tool that
  // only reads stops before its next Canvas request.
  async function processMcp(req, res) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const one = built.newServer();
    res.on('close', () => { one.close().catch(() => {}); });
    try {
      await one.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`mcp request failed: ${e.stack || e.message}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
    }
  }

  // When fronted by a public tunnel, the forwarded Host header is the tunnel's
  // hostname, not 127.0.0.1 — the default DNS-rebinding check would reject it.
  // Allow that hostname explicitly instead of disabling the check.
  const allowedHosts = AUTH_ENABLED ? [new URL(PUBLIC_URL).hostname, 'localhost', '127.0.0.1'] : undefined;
  const app = createMcpExpressApp({ host: HOST, allowedHosts });
  // The tunnel forwards from a proxy and sets X-Forwarded-For to the real
  // visitor IP; trust it (loopback only by default) so rate limiting below
  // keys on the actual client, not the tunnel's local forwarding address.
  app.set('trust proxy', TRUST_PROXY);

  let alerts = null;
  let auth = null;
  let mcpAuthMiddleware = (_req, _res, next) => next();

  async function statusData() {
    const me = await built.canvas.get('/users/self', null, { ttl: 600000 }).catch(() => null);
    const token = tokenWatch.info();
    return {
      hostname: os.hostname(), public_url: PUBLIC_URL, version: VERSION, tools: registry.length,
      started_at: START_TIME, uptime: humanDuration(Date.now() - Date.parse(START_TIME)),
      tunnel: process.env.CANVAS_MCP_TUNNEL || 'ngrok',
      base_url: cfg.base, canvas_user: me?.name || null,
      token: token ? { expires_at: token.expires_at, days_left: token.expires_at ? Math.floor((Date.parse(token.expires_at) - Date.now()) / 86400000) : null } : null,
      alerts: describeAlerts(alertSettings(process.env)),
      sessions: auth ? auth.listSessions() : [],
      logins: auth ? auth.loginHistory(15) : [],
      cluster: clusterList(),
      problems: recent.filter((r) => /error|fail|warn|could not|couldn't|refus|denied|expired|rejected/i.test(r.line)).slice(-15),
    };
  }

  /** Phone alerts about sign-ins and lockouts, when the "security" alert type is on. */
  function securityAlert(e) {
    if (!alerts) return;
    if (e.ok) {
      alerts.notify({ type: 'security', title: 'New sign-in to your Canvas server', message: `${e.app || 'An app'} connected from ${e.ip}. If that wasn't you, open the status page, sign it out and change your password.`, url: `${PUBLIC_URL}/status` }).catch(() => {});
    } else if (e.locked) {
      alerts.notify({ type: 'security', title: 'Wrong password: address locked out', message: `Someone entered the wrong password 5 times from ${e.ip}. That address is locked out for 15 minutes.`, url: `${PUBLIC_URL}/status` }).catch(() => {});
    }
  }

  if (AUTH_ENABLED) {
    const resourceUrl = new URL(`${PUBLIC_URL}/mcp`);
    auth = createOAuthProvider({ password: MCP_PASSWORD, storePath: OAUTH_STORE_PATH, historyPath: path.join(DIR, 'login-history.json'), totpSecret: TOTP_SECRET, resourceUrl: resourceUrl.href, onLogin: securityAlert });
    app.use(mcpAuthRouter({
      provider: auth.provider,
      issuerUrl: new URL(PUBLIC_URL),
      resourceServerUrl: resourceUrl,
      scopesSupported: ['canvas'],
      resourceName: 'Canvas LMS',
    }));
    // The password forms are the one unthrottled surface an internet visitor
    // can hit directly — cap attempts per IP so they aren't a free online
    // brute force against the only thing gating Canvas write access.
    const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too_many_attempts', message: 'Too many login attempts. Try again in 15 minutes.' },
    });
    app.post('/authorize/approve', loginLimiter, express.urlencoded({ extended: true }), auth.approveHandler);
    const fmt = (t) => {
      if (!t) return '';
      try { return new Date(t).toLocaleString('en-US', { timeZone: cfg.tz, dateStyle: 'medium', timeStyle: 'short' }); } catch { return new Date(t).toISOString(); }
    };
    app.use('/status', createStatusRouter({ password: MCP_PASSWORD, totpSecret: TOTP_SECRET, getStatus: statusData, revokeClient: (id) => auth.revokeClient(id), checkPassword: auth.passwordAttempt, limiter: loginLimiter, fmt }));
    app.get('/files/:key/:name', files.handler);
    mcpAuthMiddleware = requireBearerAuth({ verifier: auth.provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) });
    // Tidy sign-ins at start and once a day: expired tokens, apps that never finished signing in, unused apps.
    const tidy = () => {
      const r = auth.prune();
      if (r.removed_apps || r.removed_tokens) log(`tidied sign-ins: removed ${r.removed_apps} unused app(s) and ${r.removed_tokens} expired token(s)`);
    };
    tidy();
    setInterval(tidy, 86400000).unref();
    log(`OAuth enabled: issuer=${PUBLIC_URL}${TOTP_SECRET ? ' (with two-factor codes)' : ''}; status page at ${PUBLIC_URL}/status`);
  } else {
    log('OAuth disabled (set CANVAS_MCP_PUBLIC_URL and CANVAS_MCP_PASSWORD to enable remote access)');
  }

  // ---------------------------------------------------------------------
  // Active/standby handoff (see supervisor.js). These are NOT protected by
  // OAuth — they're machine-to-machine, gated by a separate shared secret,
  // since the standby instance calls them before it has any OAuth token.
  // The setup app and the command line use them too, for status and sessions.
  // Wrong guesses get locked out. Right answers don't count, so heartbeats never trip it.
  // ---------------------------------------------------------------------
  app.use('/internal', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_attempts' } }));

  function requireClusterSecret(req, res, next) {
    const provided = Buffer.from(String(req.headers['x-cluster-secret'] || ''));
    const expected = Buffer.from(CLUSTER_SECRET);
    if (!CLUSTER_SECRET || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  }

  // Who is answering the public address. A computer that is serving asks this through the public address too: when
  // another computer answers, both are serving, and active_since says which one took over more recently.
  app.get('/internal/whoami', requireClusterSecret, (_req, res) => {
    const sup = readSupervisorState();
    res.json({ hostname: os.hostname(), pid: process.pid, startedAt: START_TIME, active_since: sup?.state === 'active' ? sup.since : null, version: VERSION });
  });

  app.post('/internal/heartbeat', requireClusterSecret, (req, res) => {
    const { hostname, state, version } = req.body || {};
    const name = String(hostname || '').slice(0, 100);
    if (name && name !== os.hostname()) members.set(name, { hostname: name, state: String(state || 'standby').slice(0, 20), version: String(version || '').slice(0, 20), last_seen: new Date().toISOString() });
    res.json({ hostname: os.hostname(), pid: process.pid, startedAt: START_TIME, version: VERSION });
  });

  app.get('/internal/cluster', requireClusterSecret, (_req, res) => res.json({ members: clusterList() }));

  app.get('/internal/status', requireClusterSecret, async (_req, res) => {
    res.json({ ...(await statusData()), supervisor: readSupervisorState() });
  });

  app.get('/internal/sessions', requireClusterSecret, (_req, res) => res.json({ sessions: auth ? auth.listSessions() : [] }));
  app.delete('/internal/sessions/:id', requireClusterSecret, (req, res) => res.json({ signed_out: Boolean(auth?.revokeClient(req.params.id)) }));
  app.delete('/internal/sessions', requireClusterSecret, (_req, res) => res.json({ signed_out: auth ? auth.revokeAll() : 0 }));
  app.post('/internal/prune', requireClusterSecret, (_req, res) => res.json(auth ? auth.prune() : { removed_apps: 0, removed_tokens: 0 }));

  app.get('/internal/handoff', requireClusterSecret, (_req, res) => {
    try {
      res.type('application/json').send(fs.readFileSync(OAUTH_STORE_PATH, 'utf8'));
    } catch {
      res.json({ clients: {}, refreshTokens: {}, accessTokens: {} });
    }
  });

  // A request can name the computer it is meant for. When two computers share the public address it can land on
  // either one, so the other refuses it. One that names nobody (takeover, older versions) steps down whoever gets it.
  app.post('/internal/step-down', requireClusterSecret, (req, res) => {
    const { hostname, pid } = req.body || {};
    if (hostname !== undefined && (String(hostname) !== os.hostname() || Number(pid) !== process.pid)) {
      res.status(409).json({ error: 'not_me', hostname: os.hostname(), pid: process.pid });
      return;
    }
    log('received step-down request; exiting for handoff');
    res.json({ ok: true });
    setTimeout(() => process.exit(42), 200);
  });

  // GET opens a standalone, long-lived SSE stream for server-initiated push
  // notifications (spec-optional). This server never pushes anything to the
  // client, and a request designed to stay open forever would hold a server
  // open for nothing. Reject it fast instead of letting it hang.
  app.get('/mcp', (_req, res) => {
    res.set('Allow', 'POST, DELETE');
    res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed: server-initiated streams are not supported' } });
  });
  app.post('/mcp', mcpAuthMiddleware, processMcp);
  app.delete('/mcp', mcpAuthMiddleware, processMcp);
  // Public, so the setup app and uptime checkers can see the server is up. It says nothing about your account.
  app.get('/healthz', (_req, res) => res.json({ ok: true, tools: registry.length, auth_enabled: AUTH_ENABLED, version: VERSION }));

  app.listen(PORT, HOST, () => {
    log(`ready on http://${HOST}:${PORT}/mcp`);
    // Only the computer that is serving runs this, so phone alerts are never sent twice.
    if (cfg.token && cfg.api) alerts = startAlerts({ canvas: built.canvas, log, baseUrl: cfg.base });
  });
}

process.on('uncaughtException', (e) => log(`uncaught: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack || e}`));

main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
