// What the HTTP server refuses to start with. A public address without a real password would put your Canvas on the
// internet, so these stop it with a clear message instead of carrying on. Used by index.js, supervisor.js and doctor.js.
// stdio mode skips this: nothing listens on a port there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from './core/config.js';

const SETTING = { ngrok: 'CANVAS_MCP_NGROK_PATH', cloudflared: 'CANVAS_MCP_CLOUDFLARED_PATH' };
// Where Homebrew (Apple silicon and Intel), snap, Linuxbrew and hand installs put programs. A launch agent or service
// can start with a PATH that has none of these, so they're checked whatever PATH says.
const USUAL = (home) => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', '/home/linuxbrew/.linuxbrew/bin', path.posix.join(home, '.local', 'bin'), path.posix.join(home, 'bin')];

/**
 * Where the tunnel program ('ngrok' or 'cloudflared') is: the path in the settings, then on Windows the winget install,
 * then every folder on PATH and the usual install folders. Returns { path, how }, where how is 'setting', 'found' or
 * 'missing' (path is then what was tried first).
 */
export function findTunnelProgram(kind, { env = process.env, platform = process.platform, exists = fs.existsSync, home = os.homedir() } = {}) {
  if (env[SETTING[kind]]) return { path: env[SETTING[kind]], how: 'setting' };
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const file = windows ? `${kind}.exe` : kind;
  const winget = windows ? p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links', file) : null;
  const onPath = String(env.PATH || env.Path || '').split(windows ? ';' : ':').filter(Boolean);
  const candidates = [winget, ...onPath.map((d) => p.join(d, file)), ...(windows ? [] : USUAL(home).map((d) => p.join(d, file)))].filter(Boolean);
  const found = candidates.find((c) => { try { return exists(c); } catch { return false; } });
  return found ? { path: found, how: 'found' } : { path: winget || kind, how: 'missing' };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const EXAMPLE_VALUE = /^(paste_your|choose_a|generate_a)/; // the words .env.example ships with
const GOOD_PASSWORD = 12;
const GOOD_SECRET = 16;

/**
 * Returns { errors: [{ key, message }], warnings: [text] }. Any error means don't start. A short password only warns
 * for now: the setup app accepts one, and refusing it outright would take a working server offline during an update.
 */
export function startupProblems(env = process.env) {
  const errors = [];
  const warnings = [];
  const refuse = (key, message) => errors.push({ key, message });
  const host = String(env.CANVAS_MCP_HOST || '127.0.0.1').trim();
  const publicUrl = String(env.CANVAS_MCP_PUBLIC_URL || '').trim();
  const password = String(env.CANVAS_MCP_PASSWORD || '').trim();
  const secret = String(env.CANVAS_MCP_CLUSTER_SECRET || '').trim();

  if (!publicUrl && !LOOPBACK.has(host)) {
    refuse('CANVAS_MCP_PUBLIC_URL', `CANVAS_MCP_HOST is ${host}, so other computers can reach this server, but sign-in only turns on with CANVAS_MCP_PUBLIC_URL and CANVAS_MCP_PASSWORD. Set both, or use 127.0.0.1.`);
  }
  if (publicUrl && !password) refuse('CANVAS_MCP_PASSWORD', 'CANVAS_MCP_PUBLIC_URL is set but CANVAS_MCP_PASSWORD is empty, so anyone who finds the address could use your Canvas. Set a password in .env.');
  else if (publicUrl && EXAMPLE_VALUE.test(password)) refuse('CANVAS_MCP_PASSWORD', 'CANVAS_MCP_PASSWORD is still the example value from .env.example, which anyone can look up. Choose your own in .env.');
  else if (publicUrl && password.length < GOOD_PASSWORD) warnings.push(`The password is short. Use ${GOOD_PASSWORD} or more characters ("canvas-lms-mcp-remote rotate-password" makes a strong one). A later version will refuse short ones.`);

  if (secret && EXAMPLE_VALUE.test(secret)) refuse('CANVAS_MCP_CLUSTER_SECRET', 'CANVAS_MCP_CLUSTER_SECRET is still the example value from .env.example, which anyone can look up. Put a long random value in .env, the same on every computer.');
  else if (secret && secret.length < GOOD_SECRET) refuse('CANVAS_MCP_CLUSTER_SECRET', `CANVAS_MCP_CLUSTER_SECRET is too short. Use ${GOOD_SECRET} or more random characters in .env, the same on every computer.`);

  const { settingsProblem } = readConfig(env, { readStore: () => '' });
  if (settingsProblem) refuse('settings', settingsProblem);
  return { errors, warnings };
}
