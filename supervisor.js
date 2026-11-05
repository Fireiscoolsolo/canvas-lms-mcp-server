#!/usr/bin/env node
/**
 * Active/standby supervisor for running the Canvas MCP server on two
 * machines without requiring both to be on at once, and without any
 * third-party file sync. Coordination happens entirely through the shared
 * public tunnel URL (the one thing both machines can always reach,
 * regardless of what network either is on) via the /internal/* endpoints
 * in index.js.
 *
 * State machine:
 *   - On boot, ask the public URL "who's running you?" (/internal/whoami).
 *     - Nobody answers -> become active immediately.
 *     - Someone answers and they're healthy -> pull their oauth-store.json
 *       (/internal/handoff) to stay in sync, then settle into standby
 *       WITHOUT disturbing them. Forcing a takeover on every boot would
 *       cost a real outage (the ngrok domain has to be released before it
 *       can be reclaimed) for no benefit when the existing instance is
 *       fine. Standby's own polling loop below is what eventually takes
 *       over, and only once the active one actually goes quiet.
 *   - While active: run the Canvas server + the tunnel as child processes. A
 *     step-down request arrives as an HTTP call to the *server* (which
 *     exits with code 42 to signal "this was deliberate"); seeing that exit
 *     code here releases the tunnel and drops into standby. Any other exit
 *     code is treated as a crash and restarted.
 *   - While standby: send a heartbeat to the active instance periodically
 *     (/internal/heartbeat, which also lists this computer on the status
 *     page). If it stops answering for a few consecutive checks, assume the
 *     other machine went offline and become active.
 *   - Safety net: if two machines somehow try to become active at once,
 *     ngrok only lets one claim the static domain. The loser detects that
 *     (via ngrok's local inspection API) and falls back to standby.
 *
 * Requests from the command line arrive as small files in the settings
 * folder: stop.flag (shut down cleanly; `canvas-lms-mcp-remote stop`) and
 * takeover.flag (make this computer the active one; `... takeover`).
 *
 * Settings (.env): CANVAS_MCP_PUBLIC_URL and CANVAS_MCP_CLUSTER_SECRET (required, same on every machine),
 *   CANVAS_MCP_TUNNEL            ngrok (default) | cloudflared | none (you route the public address yourself)
 *   CANVAS_MCP_NGROK_PATH        where ngrok.exe is, if not the winget default
 *   CANVAS_MCP_CLOUDFLARED_TOKEN the tunnel token from the Cloudflare dashboard (CANVAS_MCP_TUNNEL=cloudflared)
 *   CANVAS_MCP_CLOUDFLARED_PATH  where cloudflared is, if not on PATH
 *   CANVAS_MCP_FAILOVER_SECONDS  how long the active computer can be silent before a standby takes over. Default 50
 * Flags: --log-file <file> writes the log there itself and rotates it at 5 MB (keeps 3 old files).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import dotenv from 'dotenv';
import { createRotatingLog } from './log-file.js';
import { redact } from './core/text.js';
import { ipFamilyFrom } from './core/config.js';
import { applyNetworkSettings } from './core/network.js';

dotenv.config({ quiet: true });
applyNetworkSettings({ ipFamily: ipFamilyFrom() });

const DIR = process.cwd(); // settings folder: .env, oauth-store.json and logs live here
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url)); // where index.js lives (differs from DIR when installed from npm)
const NODE = process.execPath;
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version;
const argValue = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const LOG_FILE = argValue('--log-file') || process.env.CANVAS_MCP_LOG_FILE || '';
const TUNNEL = String(process.env.CANVAS_MCP_TUNNEL || 'ngrok').toLowerCase();
// Auto-detect rather than hardcode a username: winget always shims CLI tools
// under the CURRENT user's %LOCALAPPDATA%, which differs per machine/account.
const NGROK = process.env.CANVAS_MCP_NGROK_PATH
  || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ngrok.exe');
const CLOUDFLARED = process.env.CANVAS_MCP_CLOUDFLARED_PATH || 'cloudflared';
const CLOUDFLARED_TOKEN = process.env.CANVAS_MCP_CLOUDFLARED_TOKEN || '';
const PUBLIC_URL = (process.env.CANVAS_MCP_PUBLIC_URL || '').replace(/\/+$/, '');
const CLUSTER_SECRET = process.env.CANVAS_MCP_CLUSTER_SECRET || '';
const PORT = Number(process.env.CANVAS_MCP_PORT || 3939);
const METRICS_PORT = Number(process.env.CANVAS_MCP_CLOUDFLARED_METRICS_PORT || PORT + 2);
const OAUTH_STORE_PATH = process.env.CANVAS_MCP_OAUTH_STORE_PATH || path.join(DIR, 'oauth-store.json');

const STEP_DOWN_EXIT_CODE = 42;
const FAILURE_THRESHOLD = 2;
const FAILOVER_MS = Math.max(10, Number(process.env.CANVAS_MCP_FAILOVER_SECONDS) || 50) * 1000;
const POLL_INTERVAL_MS = Math.max(5000, Math.round(FAILOVER_MS / FAILURE_THRESHOLD));
const SYNC_EVERY_MS = 100000; // re-pull oauth-store.json about every 100s while standby
const TUNNEL_BIND_TIMEOUT_MS = TUNNEL === 'cloudflared' ? 30000 : 12000;
const FLAG_CHECK_MS = 3000;
const FLAGS = { stop: path.join(DIR, 'stop.flag'), takeover: path.join(DIR, 'takeover.flag') };
const STATE_FILE = path.join(DIR, 'supervisor-state.json');

// ---------------------------------------------------------------------------
// Logging: secrets are removed line by line, then written to stdout or the rotating log file.
// ---------------------------------------------------------------------------
const SECRETS = [process.env.CANVAS_API_TOKEN, process.env.CANVAS_MCP_PASSWORD, CLUSTER_SECRET, CLOUDFLARED_TOKEN, process.env.CANVAS_MCP_TOTP_SECRET];
const logFile = LOG_FILE ? createRotatingLog(path.resolve(DIR, LOG_FILE)) : null;
const writeOut = (text) => {
  const clean = redact(text, SECRETS);
  if (logFile) { logFile.write(clean); if (process.stdout.isTTY) process.stdout.write(clean); }
  else process.stdout.write(clean);
};
/** Pipe a child's output through redaction one whole line at a time, so a secret is never split across writes. */
function pipeLines(stream) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d;
    const i = buf.lastIndexOf('\n');
    if (i < 0) return;
    writeOut(buf.slice(0, i + 1));
    buf = buf.slice(i + 1);
  });
  stream.on('end', () => { if (buf) writeOut(`${buf}\n`); });
}

let serverChild = null;
let tunnelChild = null;
let state = 'starting';

const log = (...a) => writeOut(`[supervisor ${new Date().toISOString()}] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setState(next) {
  state = next;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ state, since: new Date().toISOString(), hostname: os.hostname(), pid: process.pid, tunnel: TUNNEL, public_url: PUBLIC_URL, version: VERSION, log_file: logFile?.file || null }, null, 2));
  } catch { /* read-only folder */ }
}

if (!PUBLIC_URL || !CLUSTER_SECRET) {
  log('CANVAS_MCP_PUBLIC_URL and CANVAS_MCP_CLUSTER_SECRET must both be set in .env');
  process.exit(1);
}
if (TUNNEL === 'cloudflared' && !CLOUDFLARED_TOKEN) {
  log('CANVAS_MCP_TUNNEL=cloudflared needs CANVAS_MCP_CLOUDFLARED_TOKEN (the tunnel token from the Cloudflare dashboard)');
  process.exit(1);
}

async function callInternal(pathname, { method = 'GET', body, timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${PUBLIC_URL}${pathname}`, {
      method,
      headers: { 'X-Cluster-Secret': CLUSTER_SECRET, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.cause?.code ? `${e.message} (${e.cause.code})` : e.message };
  }
}

/**
 * Heartbeat to the active computer (which lists us on its status page); older versions only know /internal/whoami.
 * A lost connection gets one quick retry, so a blip here doesn't count towards deciding the other computer has gone.
 */
async function checkActive() {
  const send = () => callInternal('/internal/heartbeat', { method: 'POST', body: { hostname: os.hostname(), state, version: VERSION } });
  let hb = await send();
  if (hb.error) { await sleep(2000); hb = await send(); }
  if (hb.ok || hb.status !== 404) return hb;
  return callInternal('/internal/whoami');
}

// child.on('error') fires when spawn itself fails (bad path, ENOENT, etc.)
// and — unlike 'exit' — is NOT guaranteed to be followed by an 'exit' event.
// Previously only 'exit' was handled, so a bad path (e.g. a hardcoded
// per-user ngrok path that doesn't exist on a different machine) surfaced
// as an unhandled 'error' event, which crashes the whole supervisor process
// — and the scheduled task's restart policy just crash-loops it forever.
// Guarding each handler with a "is this still the current child?" check
// prevents double-handling if both 'error' and 'exit' fire for the same
// failed spawn, or if a stale handler fires after a fresh restart.

function startServer() {
  const child = spawn(NODE, [path.join(PKG_DIR, 'index.js')], { cwd: DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverChild = child;
  pipeLines(child.stdout);
  pipeLines(child.stderr);
  child.on('error', (err) => {
    if (serverChild !== child) return;
    log(`canvas server failed to start: ${err.message}`);
    serverChild = null;
    if (state === 'active') {
      log('retrying in 3s');
      setTimeout(() => { if (state === 'active') startServer(); }, 3000);
    }
  });
  child.on('exit', (code) => {
    if (serverChild !== child) return;
    log(`canvas server exited (code ${code})`);
    serverChild = null;
    if (code === STEP_DOWN_EXIT_CODE) {
      stopTunnel();
      enterStandby();
    } else if (state === 'active') {
      log('unexpected exit while active — restarting in 3s');
      setTimeout(() => { if (state === 'active') startServer(); }, 3000);
    }
  });
}

function startTunnel() {
  if (TUNNEL === 'none') return;
  const [cmd, args, env, label] = TUNNEL === 'cloudflared'
    ? [CLOUDFLARED, ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${METRICS_PORT}`, 'run'], { ...process.env, TUNNEL_TOKEN: CLOUDFLARED_TOKEN }, 'cloudflared']
    : [NGROK, ['http', `--url=${PUBLIC_URL}`, String(PORT), '--log=stdout'], process.env, 'ngrok'];
  const child = spawn(cmd, args, { cwd: DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelChild = child;
  pipeLines(child.stdout);
  pipeLines(child.stderr);
  child.on('error', (err) => {
    if (tunnelChild !== child) return;
    log(`${label} failed to start: ${err.message} (checked path: ${cmd})`);
    tunnelChild = null;
    if (state === 'active') {
      stopServer();
      enterStandby();
    }
  });
  child.on('exit', (code) => {
    if (tunnelChild !== child) return;
    log(`${label} exited (code ${code})`);
    tunnelChild = null;
    if (state === 'active') {
      log(`${label} died unexpectedly while active — stepping back to standby rather than serve without a public tunnel`);
      stopServer();
      enterStandby();
    }
  });
}

function stopServer() {
  if (serverChild) { serverChild.kill(); serverChild = null; }
}
function stopTunnel() {
  if (tunnelChild) { tunnelChild.kill(); tunnelChild = null; }
}

async function verifyTunnelBound(timeoutMs = TUNNEL_BIND_TIMEOUT_MS) {
  if (TUNNEL === 'none') return true;
  const targetHost = new URL(PUBLIC_URL).hostname;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (TUNNEL === 'cloudflared') {
        // cloudflared's metrics server answers /ready with 200 once at least one connection to Cloudflare is up.
        const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/ready`);
        if (res.ok) return true;
      } else {
        const res = await fetch('http://127.0.0.1:4040/api/tunnels');
        if (res.ok) {
          const data = await res.json();
          if ((data.tunnels || []).some((t) => { try { return new URL(t.public_url).hostname === targetHost; } catch { return false; } })) {
            return true;
          }
        }
      }
    } catch { /* the tunnel's local API isn't up yet, keep waiting */ }
    await sleep(1000);
  }
  return false;
}

async function becomeActive() {
  log('becoming active');
  setState('active');
  startServer();
  await sleep(1500); // give the server a moment to bind the port before the tunnel tries to forward to it
  startTunnel();
  const bound = await verifyTunnelBound();
  if (!bound) {
    log('could not claim the public tunnel (another instance likely already holds it) — stepping back to standby');
    stopTunnel();
    stopServer();
    enterStandby();
    return;
  }
  log(`active and serving at ${PUBLIC_URL}${TUNNEL === 'none' ? ' (no tunnel: the address is routed outside this program)' : ` through ${TUNNEL}`}`);
}

async function enterStandby() {
  if (state === 'standby') return;
  setState('standby');
  log(`entering standby, watching for the active instance to go quiet (takes over after about ${Math.round(FAILOVER_MS / 1000)}s of silence)`);
  let failures = 0;
  let lastSync = Date.now();
  while (state === 'standby') {
    await sleep(POLL_INTERVAL_MS);
    if (state !== 'standby') return;
    const who = await checkActive();
    if (state !== 'standby') return;
    if (who.ok) {
      failures = 0;
      // Keep the local token store warm. Refresh tokens rotate on every use
      // and access tokens expire hourly, so the boot-time-only copy goes
      // stale within about an hour — and taking over with a stale copy
      // would log out every connected device.
      if (Date.now() - lastSync > SYNC_EVERY_MS) {
        lastSync = Date.now();
        await syncHandoffData({ quiet: true });
      }
    } else {
      failures++;
      log(`heartbeat failed (${failures}/${FAILURE_THRESHOLD}): ${who.error || who.status}`);
      if (failures >= FAILURE_THRESHOLD) {
        log('active instance appears to be gone — taking over');
        await sleep(Math.random() * 4000); // jitter, in case both standbys notice at once
        if (state === 'standby') await becomeActive();
        return;
      }
    }
  }
}

async function syncHandoffData({ quiet = false } = {}) {
  const handoff = await callInternal('/internal/handoff');
  if (handoff.ok && handoff.data && typeof handoff.data === 'object' && !Array.isArray(handoff.data)) {
    fs.writeFileSync(OAUTH_STORE_PATH, JSON.stringify(handoff.data, null, 2));
    if (!quiet) log('synced session data from the active instance');
  } else {
    log(`could not sync session data (${handoff.error || handoff.status || 'malformed response'}) — using local data as-is`);
  }
}

/** "Make this computer the active one": ask the active one to step down, wait for it to go quiet, then take over. */
async function takeOver() {
  if (state !== 'standby') { log('takeover asked, but this computer is already serving'); return; }
  setState('taking-over');
  log('taking over at the request of this computer');
  await syncHandoffData({ quiet: true });
  const asked = await callInternal('/internal/step-down', { method: 'POST' });
  if (!asked.ok) log(`the active computer didn't answer the step-down request (${asked.error || asked.status}); taking over anyway`);
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    if (!(await callInternal('/internal/whoami', { timeoutMs: 3000 })).ok) break;
  }
  await becomeActive();
}

let checkingFlags = false;
async function checkFlags() {
  if (checkingFlags) return;
  checkingFlags = true;
  try {
    if (fs.existsSync(FLAGS.stop)) {
      fs.rmSync(FLAGS.stop, { force: true });
      log('stopping (asked by "canvas-lms-mcp-remote stop")');
      shutdown(0);
    }
    if (fs.existsSync(FLAGS.takeover)) {
      fs.rmSync(FLAGS.takeover, { force: true });
      await takeOver();
    }
  } finally {
    checkingFlags = false;
  }
}

async function main() {
  log(`starting on ${os.hostname()} (version ${VERSION}, tunnel ${TUNNEL})`);
  for (const f of Object.values(FLAGS)) fs.rmSync(f, { force: true }); // requests left over from before a restart
  setInterval(checkFlags, FLAG_CHECK_MS).unref?.();
  const who = await callInternal('/internal/whoami');
  if (who.ok) {
    log(`${who.data?.hostname || 'another instance'} is already active and healthy — syncing data and starting in standby`);
    await syncHandoffData();
    await enterStandby();
  } else {
    await becomeActive();
  }
}

function shutdown(code = 0) {
  log('shutting down');
  stopServer();
  stopTunnel();
  setState('stopped');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
