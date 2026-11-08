#!/usr/bin/env node
// Command-line entry for the npm package. Run it from the folder that holds your .env.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.cwd();
const ENV_FILE = path.join(DIR, '.env');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version;
const args = process.argv.slice(2);
// Options that take a value: the value after them is never the command, so `--log-file supervisor.log` alone starts it.
const VALUE_OPTIONS = new Set(['--log-file', '--name', '--lines', '--password']);
const positional = args.filter((a, i) => !a.startsWith('-') && !VALUE_OPTIONS.has(args[i - 1]));
const cmd = positional[0] || 'start';
const rest = positional.slice(1);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const stdio = flag('--stdio') || cmd === 'stdio' || process.env.CANVAS_MCP_TRANSPORT === 'stdio';

const usage = `canvas-lms-mcp-remote ${VERSION}: self-hosted Canvas LMS MCP server

Run these from the folder that holds your .env (it also stores logins and logs):

Running it
  canvas-lms-mcp-remote init              Create a .env template here
  canvas-lms-mcp-remote                   Start the supervisor: server + tunnel + failover (add --log-file supervisor.log)
  canvas-lms-mcp-remote serve             Start only the HTTP server on 127.0.0.1 (no tunnel)
  canvas-lms-mcp-remote install-service   Start it automatically when you sign in (Windows, Linux or macOS)
  canvas-lms-mcp-remote uninstall-service Stop starting it automatically
  canvas-lms-mcp-remote stop | restart    Stop the running supervisor, or stop and start it again
  canvas-lms-mcp-remote uninstall         Stop it, remove the startup service and say how to remove the package

Checking on it
  canvas-lms-mcp-remote status            Is it running, which computer is serving, who is signed in
  canvas-lms-mcp-remote logs [-f]         Show the end of supervisor.log (-f keeps following it)
  canvas-lms-mcp-remote doctor            Check the settings, token, tunnel and startup service, and say how to fix problems
  canvas-lms-mcp-remote test-alert        Send a test phone alert using the alert settings in .env

Security and sign-ins
  canvas-lms-mcp-remote sessions                 List signed-in apps
  canvas-lms-mcp-remote sessions sign-out <id>   Sign one app out (or: sessions sign-out-all)
  canvas-lms-mcp-remote rotate-password          Make a new password and sign every app out
  canvas-lms-mcp-remote totp-setup | totp-off    Turn two-factor codes on or off for the login page

Several computers
  canvas-lms-mcp-remote cluster           List the computers in your group and which one is serving
  canvas-lms-mcp-remote takeover          Make this computer the one that serves

  canvas-lms-mcp-remote --stdio           Serve over stdin/stdout (for directory checks)

Guide: https://github.com/Fireiscoolsolo/canvas-lms-mcp-server#quick-start`;

const say = (s = '') => console.log(s);
const fail = (msg) => { console.error(msg); process.exit(1); };

async function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) fail(`There is no .env in ${DIR}. Run this from your settings folder, or run "canvas-lms-mcp-remote init".`);
  (await import('dotenv')).default.config({ path: ENV_FILE, quiet: true });
  return process.env;
}

/** Call the serving computer's /internal endpoint through the public address. */
async function internal(env, pathname, method = 'GET') {
  const base = String(env.CANVAS_MCP_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base || !env.CANVAS_MCP_CLUSTER_SECRET) throw new Error('CANVAS_MCP_PUBLIC_URL and CANVAS_MCP_CLUSTER_SECRET must be set in .env.');
  const res = await fetch(`${base}${pathname}`, { method, headers: { 'X-Cluster-Secret': env.CANVAS_MCP_CLUSTER_SECRET, 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 403) throw new Error('The server refused the cluster secret. CANVAS_MCP_CLUSTER_SECRET must match on every computer.');
  if (res.status === 429) throw new Error('The server is locked for this address after too many wrong cluster secrets. Fix CANVAS_MCP_CLUSTER_SECRET, wait 15 minutes and try again.');
  if (!res.ok) throw new Error(`The server answered HTTP ${res.status}. Is it running? Try "canvas-lms-mcp-remote status".`);
  return res.json();
}

const readState = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'supervisor-state.json'), 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const when = (t) => (t ? new Date(t).toLocaleString() : 'never');

/** Ask the local supervisor to stop (it watches for stop.flag) and wait until it has. */
async function stopLocal() {
  const s = readState();
  if (!s || s.state === 'stopped') return false;
  fs.writeFileSync(path.join(DIR, 'stop.flag'), new Date().toISOString());
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (readState()?.state === 'stopped') return true;
  }
  fs.rmSync(path.join(DIR, 'stop.flag'), { force: true });
  throw new Error(`The supervisor didn't stop within 20 seconds (it may be an older version that doesn't know "stop"). Stop it from Task Manager, then try again.`);
}

const commands = {
  async init() {
    if (fs.existsSync(ENV_FILE)) return say(`.env already exists in ${DIR}, leaving it unchanged.`);
    fs.copyFileSync(path.join(PKG_DIR, '.env.example'), ENV_FILE);
    say(`Created ${ENV_FILE}\nFill in your Canvas token, ngrok domain, password and cluster secret, then run: canvas-lms-mcp-remote\nOn Windows, the free Canvas MCP Installer Assistant can do all of this for you: https://fireiscoolsolo.github.io/canvas-lms-mcp-local/app/`);
  },

  async 'test-alert'() {
    await loadEnv();
    const { sendTestAlert } = await import('./alerts.js');
    const { channels, failed } = await sendTestAlert();
    say(`Sent a test alert via ${channels.join(', ')}. Check your phone.`);
    for (const f of failed) say(`Not sent: ${f}`);
  },

  async status() {
    const env = await loadEnv();
    const s = readState();
    say(`This computer: ${s ? `${s.state} since ${when(s.since)} (version ${s.version}, tunnel ${s.tunnel})` : 'the supervisor has not run from this folder yet'}`);
    try {
      const local = await fetch(`http://127.0.0.1:${env.CANVAS_MCP_PORT || 3939}/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
      say(`Local server: running, ${local.tools} tools`);
    } catch { say('Local server: not running on this computer'); }
    try {
      const st = await internal(env, '/internal/status');
      say(`\nPublic address: ${st.public_url} (served by ${st.hostname}, up ${st.uptime})`);
      say(`Canvas: ${st.canvas_user ? `signed in as ${st.canvas_user}` : 'not connected'}${st.token?.days_left != null ? `, token expires in ${st.token.days_left} days` : ''}`);
      say(`Phone alerts: ${st.alerts.on ? `on via ${st.alerts.channels.join(', ')}` : 'off'}`);
      say(`Signed-in apps: ${st.sessions.filter((x) => x.signed_in).map((x) => x.app).join(', ') || 'none'}`);
      if (st.cluster.length > 1) say(`Computers: ${st.cluster.map((m) => `${m.hostname} (${m.state})`).join(', ')}`);
      if (st.problems.length) say(`\nRecent problems:\n${st.problems.slice(-5).map((p) => `  ${when(p.at)}  ${p.line}`).join('\n')}`);
      say(`\nStatus page: ${st.public_url}/status`);
    } catch (e) { say(`\nPublic address: not reachable (${e.message})`); }
  },

  async logs() {
    const file = path.join(DIR, 'supervisor.log');
    if (!fs.existsSync(file)) fail(`No supervisor.log in ${DIR}.`);
    const lines = Number(option('--lines') || 60);
    say(fs.readFileSync(file, 'utf8').split('\n').slice(-lines - 1).join('\n'));
    if (!flag('-f') && !flag('--follow')) return;
    let size = fs.statSync(file).size;
    fs.watchFile(file, { interval: 1000 }, (cur) => {
      if (cur.size < size) size = 0; // rotated
      if (cur.size > size) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(cur.size - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        process.stdout.write(buf.toString('utf8'));
        size = cur.size;
      }
    });
  },

  async doctor() {
    const { runDoctor } = await import('./doctor.js');
    process.exitCode = await runDoctor({ dir: DIR, version: VERSION });
  },

  async 'install-service'() {
    const { installService } = await import('./service.js');
    const r = installService({ dir: DIR, name: option('--name') });
    say(`Installed the ${r.kind}${r.name ? ` "${r.name}"` : ''}. ${r.note}\nIt writes supervisor.log in ${DIR} and rotates it at 5 MB.`);
  },

  async 'uninstall-service'() {
    const { uninstallService } = await import('./service.js');
    say(uninstallService({ name: option('--name') }) ? 'Removed the startup service.' : 'There was no startup service to remove.');
  },

  async stop() {
    say((await stopLocal()) ? 'Stopped.' : 'It is not running from this folder.');
  },

  async restart() {
    await stopLocal();
    const { startService } = await import('./service.js');
    if (startService({ name: option('--name') })) say('Restarted through the startup service.');
    else say('Stopped. There is no startup service to start it again; run "canvas-lms-mcp-remote" (or install-service) to start it.');
  },

  async uninstall() {
    await stopLocal().catch((e) => say(e.message));
    const { uninstallService } = await import('./service.js');
    uninstallService({ name: option('--name') });
    say(`Stopped it and removed the startup service.\nTo remove the program: npm uninstall -g canvas-lms-mcp-remote\nYour settings folder (${DIR}) still holds .env, logins and logs; delete it when you no longer need it.\nAlso remove the Canvas connector from your AI apps, and delete the Canvas token in Canvas (Account > Settings).`);
  },

  async sessions() {
    const env = await loadEnv();
    const [action, id] = rest;
    if (action === 'sign-out' && id) return say((await internal(env, `/internal/sessions/${encodeURIComponent(id)}`, 'DELETE')).signed_out ? 'Signed out.' : 'No app with that ID.');
    if (action === 'sign-out-all') return say(`Signed out ${(await internal(env, '/internal/sessions', 'DELETE')).signed_out} app(s).`);
    if (action === 'tidy') { const r = await internal(env, '/internal/prune', 'POST'); return say(`Removed ${r.removed_apps} unused app(s) and ${r.removed_tokens} expired token(s).`); }
    const { sessions } = await internal(env, '/internal/sessions');
    if (!sessions.length) return say('No apps have signed in.');
    for (const s of sessions) say(`${s.signed_in ? '●' : '○'} ${s.app}  last used ${when(s.last_used)}  id ${s.client_id}`);
    say('\nSign one out with: canvas-lms-mcp-remote sessions sign-out <id>');
  },

  async 'rotate-password'() {
    const env = await loadEnv();
    const { setEnvValues } = await import('./env-file.js');
    const password = option('--password') || crypto.randomBytes(18).toString('base64url');
    if (password.length < 12) fail('Use a password of at least 12 characters.');
    const backup = setEnvValues(ENV_FILE, { CANVAS_MCP_PASSWORD: password });
    let signedOut = null;
    if (!flag('--keep-sessions')) signedOut = await internal(env, '/internal/sessions', 'DELETE').then((r) => r.signed_out).catch(() => null);
    say(`New password saved in .env (old file backed up to ${backup}):\n\n  ${password}\n`);
    say(signedOut === null ? 'The server wasn\'t reachable, so apps are still signed in; run "canvas-lms-mcp-remote sessions sign-out-all" once it is up.' : `Signed out ${signedOut} app(s); they will ask for the new password.`);
    say('\nRestart the server so it uses the new password: canvas-lms-mcp-remote restart');
    say('If you run this on more than one computer, put the same CANVAS_MCP_PASSWORD in each computer\'s .env (the setup app\'s Auto update can do it), or the old password keeps working when another computer takes over.');
  },

  async 'totp-setup'() {
    await loadEnv();
    const { generateSecret, otpauthUrl } = await import('./totp.js');
    const { setEnvValues } = await import('./env-file.js');
    const secret = generateSecret();
    setEnvValues(ENV_FILE, { CANVAS_MCP_TOTP_SECRET: secret });
    say(`Two-factor codes are on. Add this to your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password...):\n\n  Secret: ${secret}\n  Link:   ${otpauthUrl(secret)}\n`);
    say('Restart the server (canvas-lms-mcp-remote restart). After that, signing in and the status page ask for the 6-digit code.');
    say('On other computers in your group, put the same CANVAS_MCP_TOTP_SECRET in their .env.');
  },

  async 'totp-off'() {
    await loadEnv();
    const { setEnvValues } = await import('./env-file.js');
    setEnvValues(ENV_FILE, { CANVAS_MCP_TOTP_SECRET: null });
    say('Two-factor codes are off. Restart the server (canvas-lms-mcp-remote restart) to apply it.');
  },

  async cluster() {
    const env = await loadEnv();
    const { members } = await internal(env, '/internal/cluster');
    for (const m of members) say(`${m.state === 'active' ? '●' : '○'} ${m.hostname}  ${m.state === 'active' ? 'serving' : m.state}  version ${m.version || '?'}  last heard ${when(m.last_seen)}`);
  },

  async takeover() {
    const s = readState();
    if (!s || s.state === 'stopped') fail('The supervisor isn\'t running on this computer. Start it first (canvas-lms-mcp-remote, or install-service).');
    if (s.state === 'active') return say('This computer is already the one serving.');
    fs.writeFileSync(path.join(DIR, 'takeover.flag'), new Date().toISOString());
    say('Asked this computer to take over. It will be serving in about 30 seconds; watch with "canvas-lms-mcp-remote logs -f".');
  },
};

if (flag('--help') || flag('-h') || cmd === 'help') {
  say(usage);
} else if (flag('--version') || flag('-v')) {
  say(VERSION);
} else if (stdio) {
  process.env.CANVAS_MCP_TRANSPORT = 'stdio';
  await import('./index.js');
} else if (cmd === 'serve') {
  await import('./index.js');
} else if (cmd === 'start') {
  await import('./supervisor.js');
} else if (commands[cmd]) {
  try {
    await commands[cmd]();
  } catch (e) {
    fail(e.message);
  }
} else {
  console.error(`Unknown command: ${cmd}\n\n${usage}`);
  process.exit(1);
}
