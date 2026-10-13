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
 *   - While active: run the Canvas server + ngrok as child processes. A
 *     step-down request arrives as an HTTP call to the *server* (which
 *     exits with code 42 to signal "this was deliberate"); seeing that exit
 *     code here releases ngrok and drops into standby. Any other exit code
 *     is treated as a crash and restarted.
 *   - While standby: poll /internal/whoami periodically. If it stops
 *     responding for a few consecutive checks, assume the other machine
 *     went offline and become active.
 *   - Safety net: if two machines somehow try to become active at once,
 *     ngrok only lets one claim the static domain. The loser detects that
 *     (via ngrok's local inspection API) and falls back to standby.
 *
 * Requires the same CANVAS_MCP_PUBLIC_URL, CANVAS_MCP_CLUSTER_SECRET, and
 * CANVAS_MCP_OAUTH_STORE_PATH-relevant .env values on every machine running
 * this. Run via run-supervisor.cmd / the CanvasSupervisor scheduled task.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';

dotenv.config();

const DIR = process.cwd();
const NODE = process.execPath;
// Auto-detect rather than hardcode a username: winget always shims CLI tools
// under the CURRENT user's %LOCALAPPDATA%, which differs per machine/account.
const NGROK = process.env.CANVAS_MCP_NGROK_PATH
  || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ngrok.exe');
const PUBLIC_URL = (process.env.CANVAS_MCP_PUBLIC_URL || '').replace(/\/+$/, '');
const CLUSTER_SECRET = process.env.CANVAS_MCP_CLUSTER_SECRET || '';
const PORT = Number(process.env.CANVAS_MCP_PORT || 3939);
const OAUTH_STORE_PATH = process.env.CANVAS_MCP_OAUTH_STORE_PATH || path.join(DIR, 'oauth-store.json');

const STEP_DOWN_EXIT_CODE = 42;
const POLL_INTERVAL_MS = 25000;
const FAILURE_THRESHOLD = 2;
const SYNC_EVERY_N_POLLS = 4; // re-pull oauth-store.json ~every 100s while standby
const NGROK_BIND_TIMEOUT_MS = 12000;

if (!PUBLIC_URL || !CLUSTER_SECRET) {
  console.error('[supervisor] CANVAS_MCP_PUBLIC_URL and CANVAS_MCP_CLUSTER_SECRET must both be set in .env');
  process.exit(1);
}

let serverChild = null;
let ngrokChild = null;
let state = 'starting';

const log = (...a) => console.log(`[supervisor ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callInternal(pathname, { method = 'GET', timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${PUBLIC_URL}${pathname}`, {
      method,
      headers: { 'X-Cluster-Secret': CLUSTER_SECRET },
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
    return { ok: false, error: e.message };
  }
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
  const child = spawn(NODE, ['index.js'], { cwd: DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverChild = child;
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
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
      stopNgrok();
      enterStandby();
    } else if (state === 'active') {
      log('unexpected exit while active — restarting in 3s');
      setTimeout(() => { if (state === 'active') startServer(); }, 3000);
    }
  });
}

function startNgrok() {
  const child = spawn(NGROK, ['http', `--url=${PUBLIC_URL}`, String(PORT), '--log=stdout'], { cwd: DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  ngrokChild = child;
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (err) => {
    if (ngrokChild !== child) return;
    log(`ngrok failed to start: ${err.message} (checked path: ${NGROK})`);
    ngrokChild = null;
    if (state === 'active') {
      stopServer();
      enterStandby();
    }
  });
  child.on('exit', (code) => {
    if (ngrokChild !== child) return;
    log(`ngrok exited (code ${code})`);
    ngrokChild = null;
    if (state === 'active') {
      log('ngrok died unexpectedly while active — stepping back to standby rather than serve without a public tunnel');
      stopServer();
      enterStandby();
    }
  });
}

function stopServer() {
  if (serverChild) { serverChild.kill(); serverChild = null; }
}
function stopNgrok() {
  if (ngrokChild) { ngrokChild.kill(); ngrokChild = null; }
}

async function verifyNgrokBound(timeoutMs = NGROK_BIND_TIMEOUT_MS) {
  const targetHost = new URL(PUBLIC_URL).hostname;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels');
      if (res.ok) {
        const data = await res.json();
        if ((data.tunnels || []).some((t) => { try { return new URL(t.public_url).hostname === targetHost; } catch { return false; } })) {
          return true;
        }
      }
    } catch { /* ngrok's local API isn't up yet, keep waiting */ }
    await sleep(1000);
  }
  return false;
}

async function becomeActive() {
  log('becoming active');
  state = 'active';
  startServer();
  await sleep(1500); // give the server a moment to bind the port before ngrok tries to forward to it
  startNgrok();
  const bound = await verifyNgrokBound();
  if (!bound) {
    log('could not claim the public tunnel (another instance likely already holds it) — stepping back to standby');
    stopNgrok();
    stopServer();
    enterStandby();
    return;
  }
  log(`active and serving at ${PUBLIC_URL}`);
}

async function enterStandby() {
  if (state === 'standby') return;
  state = 'standby';
  log('entering standby, watching for the active instance to go quiet');
  let failures = 0;
  let sinceSync = 0;
  while (state === 'standby') {
    await sleep(POLL_INTERVAL_MS);
    if (state !== 'standby') return;
    const who = await callInternal('/internal/whoami');
    if (who.ok) {
      failures = 0;
      // Keep the local token store warm. Refresh tokens rotate on every use
      // and access tokens expire hourly, so the boot-time-only copy goes
      // stale within about an hour — and taking over with a stale copy
      // would log out every connected device.
      if (++sinceSync >= SYNC_EVERY_N_POLLS) {
        sinceSync = 0;
        await syncHandoffData({ quiet: true });
      }
    } else {
      failures++;
      log(`whoami check failed (${failures}/${FAILURE_THRESHOLD}): ${who.error || who.status}`);
      if (failures >= FAILURE_THRESHOLD) {
        log('active instance appears to be gone — taking over');
        await sleep(Math.random() * 4000); // jitter, in case both standbys notice at once
        await becomeActive();
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

async function main() {
  log(`starting on ${os.hostname()}`);
  const who = await callInternal('/internal/whoami');
  if (who.ok) {
    log(`${who.data?.hostname || 'another instance'} is already active and healthy — syncing data and starting in standby`);
    await syncHandoffData();
    await enterStandby();
  } else {
    await becomeActive();
  }
}

function shutdown() {
  log('shutting down');
  stopServer();
  stopNgrok();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
