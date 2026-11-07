// `canvas-lms-mcp-remote doctor`: checks the settings folder, the Canvas token, the tunnel, the local server, the
// public address and the startup service, and says how to fix each problem. Nothing secret is printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from './env-file.js';
import { serviceInfo } from './service.js';
import { matchToken, daysLeft } from './core/token-watch.js';
import { normalizeBase } from './core/canvas-client.js';
import { ipFamilyFrom } from './core/config.js';
import { applyNetworkSettings, checkConnections, reportConnections } from './core/network.js';
import { startupProblems } from './startup-check.js';

const REQUIRED = {
  CANVAS_API_TOKEN: 'your Canvas token (Canvas > Account > Settings > + New Access Token)',
  CANVAS_BASE_URL: 'your school\'s Canvas address, e.g. https://yourschool.instructure.com',
  CANVAS_MCP_PUBLIC_URL: 'your public address, e.g. https://your-name.ngrok-free.dev',
  CANVAS_MCP_PASSWORD: 'the password apps use to sign in',
  CANVAS_MCP_CLUSTER_SECRET: 'a long random secret, the same on every computer',
};

/** ngrok keeps its authtoken in one of these files. */
function ngrokAuthConfigured(env = process.env) {
  const files = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'ngrok', 'ngrok.yml'),
    path.join(os.homedir(), '.ngrok2', 'ngrok.yml'),
    path.join(os.homedir(), '.config', 'ngrok', 'ngrok.yml'),
    path.join(os.homedir(), 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
  ].filter(Boolean);
  return files.some((f) => { try { return /^\s*authtoken:\s*\S+/m.test(fs.readFileSync(f, 'utf8')); } catch { return false; } });
}

export async function runDoctor({ dir, version, fetchImpl = fetch, service = serviceInfo, network = checkConnections }) {
  let problems = 0;
  const good = (m) => console.log(`  ✔ ${m}`);
  const bad = (m, fix) => { problems++; console.log(`  ✖ ${m}${fix ? `\n      Fix: ${fix}` : ''}`); };
  const note = (m) => console.log(`  - ${m}`);
  const warn = (m) => console.log(`  ! ${m}`);
  console.log(`Canvas MCP Remote doctor (version ${version})\n\nSettings (${dir}):`);

  const env = readEnv(path.join(dir, '.env'));
  if (!env) {
    bad('There is no .env here', 'Run this from your settings folder, or create one with "canvas-lms-mcp-remote init".');
    console.log(`\n${problems} problem found.`);
    return 1;
  }
  applyNetworkSettings({ ipFamily: ipFamilyFrom(env) });
  const reported = new Set();
  for (const [k, what] of Object.entries(REQUIRED)) {
    if (!env[k] || /paste_your|choose_a|generate_a|your-domain|yourschool/.test(env[k])) { bad(`${k} is not set`, `Add ${what} to .env.`); reported.add(k); }
  }
  const startup = startupProblems(env);
  for (const e of startup.errors) if (!reported.has(e.key)) bad(`The server won't start: ${e.message}`);
  for (const w of startup.warnings) warn(w);
  if (env.CANVAS_MCP_TOTP_SECRET) good('Two-factor codes are on');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) good(`Node.js ${process.versions.node}`); else bad(`Node.js ${process.versions.node} is too old`, 'Install Node.js 20 or newer from https://nodejs.org');

  console.log('\nCanvas:');
  const base = normalizeBase(env.CANVAS_BASE_URL);
  if (base && env.CANVAS_API_TOKEN) {
    const get = (p) => fetchImpl(`${base}/api/v1${p}`, { headers: { Authorization: `Bearer ${env.CANVAS_API_TOKEN}` }, signal: AbortSignal.timeout(20000) });
    try {
      const res = await get('/users/self');
      if (res.status === 401) bad('Canvas rejected the token (expired, deleted or copied wrong)', `Make a new one at ${base}/profile/settings and put it in .env (or use Auto update in the setup app).`);
      else if (!res.ok) bad(`Canvas answered HTTP ${res.status}`, 'Check CANVAS_BASE_URL.');
      else {
        const me = await res.json();
        good(`Signed in to ${base} as ${me.name}`);
        const t = await get(`/users/${me.id}/user_generated_tokens?per_page=100`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
        const d = daysLeft(matchToken(t, env.CANVAS_API_TOKEN)?.expires_at);
        if (d !== null && d <= 7) { problems++; warn(`The token expires in ${Math.max(0, Math.ceil(d))} day(s). Make a new one before it stops working.`); }
        else if (d !== null) note(`The token expires in ${Math.ceil(d)} days.`);
      }
    } catch (e) { bad(`Couldn't reach ${base} (${e.cause?.code || e.message})`, 'Check your internet connection and CANVAS_BASE_URL.'); }
  }

  if (base.startsWith('https:')) {
    console.log('\nNetwork:');
    await reportConnections(base, { good, bad }, network);
  }

  console.log('\nTunnel:');
  const tunnel = String(env.CANVAS_MCP_TUNNEL || 'ngrok').toLowerCase();
  if (tunnel === 'ngrok') {
    const ngrok = env.CANVAS_MCP_NGROK_PATH || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ngrok.exe');
    if (process.platform !== 'win32' && !env.CANVAS_MCP_NGROK_PATH) note('Using "ngrok" from your PATH');
    else if (fs.existsSync(ngrok)) good(`ngrok found at ${ngrok}`); else bad(`ngrok wasn't found at ${ngrok}`, 'Install it (winget install ngrok.ngrok) or set CANVAS_MCP_NGROK_PATH.');
    if (ngrokAuthConfigured()) good('ngrok is signed in (authtoken set)'); else bad('ngrok has no authtoken', 'Run: ngrok config add-authtoken <your token from dashboard.ngrok.com>');
  } else if (tunnel === 'cloudflared') {
    if (env.CANVAS_MCP_CLOUDFLARED_TOKEN) good('Cloudflare Tunnel token is set'); else bad('CANVAS_MCP_CLOUDFLARED_TOKEN is not set', 'Copy the tunnel token from the Cloudflare dashboard (Zero Trust > Networks > Tunnels).');
  } else {
    note('No tunnel (CANVAS_MCP_TUNNEL=none): your public address must reach this computer some other way.');
  }

  console.log('\nServer:');
  const port = Number(env.CANVAS_MCP_PORT || 3939);
  try {
    const h = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    good(`Running on this computer (port ${port}, ${h.tools} tools${h.version ? `, version ${h.version}` : ''})`);
  } catch { note(`Not running on this computer right now (that's fine if another computer is serving).`); }
  const pub = String(env.CANVAS_MCP_PUBLIC_URL || '').replace(/\/+$/, '');
  if (pub) {
    try {
      const res = await fetchImpl(`${pub}/healthz`, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      if (res.ok && /"ok":true/.test(text)) good(`${pub} answers (the server is reachable from anywhere)`);
      else if (/ERR_NGROK_3200/.test(text)) bad(`${pub} is offline: no computer is serving it`, 'Start the server: canvas-lms-mcp-remote (or "canvas-lms-mcp-remote restart").');
      else bad(`${pub} answered, but not like the Canvas server (HTTP ${res.status})`, 'Check CANVAS_MCP_PUBLIC_URL matches your tunnel address.');
    } catch { bad(`Couldn't reach ${pub}`, 'Check the address and that the server is running.'); }
  }

  console.log('\nStarting automatically:');
  const svc = service();
  if (!svc.installed) bad(`No startup service (${svc.kind})`, 'Run: canvas-lms-mcp-remote install-service');
  else {
    good(`${svc.kind} "${svc.name}" is set up${svc.state ? ` (${svc.state})` : ''}`);
    if (svc.oldLog) warn('It uses the old log setup, so supervisor.log grows forever. Run "canvas-lms-mcp-remote install-service" again to switch to the rotating log.');
    if (svc.dir && path.resolve(svc.dir) !== path.resolve(dir)) warn(`It runs from ${svc.dir}, not this folder.`);
  }
  try {
    const size = fs.statSync(path.join(dir, 'supervisor.log')).size;
    if (size > 50 * 1024 * 1024) warn(`supervisor.log is ${Math.round(size / 1048576)} MB. Reinstalling the service turns on rotation; you can delete the old file once the server is stopped.`);
  } catch { /* no log yet */ }

  console.log(problems ? `\n${problems} problem${problems === 1 ? '' : 's'} found.` : '\nEverything looks good.');
  return problems ? 1 : 0;
}
