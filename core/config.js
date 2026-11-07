// Server settings from environment variables, shared by the Local and Remote servers.
//
//   CANVAS_API_TOKEN       Personal access token (Canvas > Settings > New Access Token)
//   CANVAS_API_TOKEN_FILE  Or: path to a file that holds only the token
//   CANVAS_TOKEN_STORE     Or: "keychain" to read it from Windows Credential Manager / macOS Keychain / secret-tool
//   CANVAS_BASE_URL        e.g. https://yourschool.instructure.com (with or without /api/v1)
//   CANVAS_ALLOW_WRITES    false (or 0, no, off) removes every tool that changes Canvas. Default: true
//   CANVAS_PROFILE         "full" (default, all tools) | "core" (curated subset)
//   CANVAS_TOOLS           Only these groups or tool names, comma-separated, e.g. "grades,planning,whoami"
//   CANVAS_DISABLE_TOOLS   Leave out these groups or tool names, comma-separated
//   CANVAS_CACHE_TTL       Cache lifetime in seconds. Default: 60
//   CANVAS_TIMEZONE        IANA time zone for dates. Default: this computer's
//   CANVAS_DOWNLOAD_DIR    Where download tools save files
//   CANVAS_MAX_RESPONSE_CHARS  Longest answer a tool returns before it is cut, in characters. Default: 100000
//   CANVAS_IP_FAMILY       4 or 6 uses only that kind of address. Default: both
import fs from 'node:fs';
import path from 'node:path';
import { normalizeBase } from './canvas-client.js';
import { readStoredToken, storeName } from './token-store.js';

const list = (v) => {
  const items = String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? new Set(items) : null;
};

/** Where the token comes from, and the token itself. Never throws: problems come back as `tokenError`. */
export function resolveToken(env = process.env, { readStore = readStoredToken } = {}) {
  if (env.CANVAS_API_TOKEN) return { token: String(env.CANVAS_API_TOKEN).trim(), tokenSource: 'env' };
  if (env.CANVAS_API_TOKEN_FILE) {
    try {
      return { token: fs.readFileSync(env.CANVAS_API_TOKEN_FILE, 'utf8').trim(), tokenSource: 'file' };
    } catch (e) {
      return { token: '', tokenSource: 'file', tokenError: `Couldn't read CANVAS_API_TOKEN_FILE (${env.CANVAS_API_TOKEN_FILE}): ${e.code || e.message}` };
    }
  }
  if (/^(keychain|keyring|credential-?manager|os)$/i.test(String(env.CANVAS_TOKEN_STORE || ''))) {
    try {
      const token = readStore();
      return token ? { token, tokenSource: 'keychain' } : { token: '', tokenSource: 'keychain', tokenError: `No Canvas token is saved in ${storeName()}. Run: npx canvas-lms-mcp-local setup` };
    } catch (e) {
      return { token: '', tokenSource: 'keychain', tokenError: e.message };
    }
  }
  return { token: '', tokenSource: 'none' };
}

export const ipFamilyFrom = (env = process.env) => (['4', '6'].includes(String(env.CANVAS_IP_FAMILY).trim()) ? Number(env.CANVAS_IP_FAMILY) : null);

const YES = new Set(['true', '1', 'yes', 'on']);
const NO = new Set(['false', '0', 'no', 'off']);

/** Never really set. An app that can't fill in a setting can leave its ${placeholder} behind. */
const blank = (v) => !String(v ?? '').trim() || /^\$\{.*\}$/.test(String(v).trim());

/**
 * The settings that restrict what the server may do. A value nobody can read must never mean "no restriction", so it
 * falls back to the safe choice and is reported: tools refuse with the message, and Remote won't start.
 */
function readLimits(env) {
  const problems = [];
  const writes = String(env.CANVAS_ALLOW_WRITES ?? '').trim().toLowerCase();
  const profile = String(env.CANVAS_PROFILE ?? '').trim().toLowerCase();
  const writesOn = blank(env.CANVAS_ALLOW_WRITES) || YES.has(writes);
  const everything = blank(env.CANVAS_PROFILE) || profile === 'full';
  if (!writesOn && !NO.has(writes)) problems.push(`CANVAS_ALLOW_WRITES is set to "${env.CANVAS_ALLOW_WRITES}", which this server can't read. Use true or false.`);
  if (!everything && profile !== 'core') problems.push(`CANVAS_PROFILE is set to "${env.CANVAS_PROFILE}", which this server can't read. Use full or core.`);
  return { allowWrites: writesOn, profile: everything ? 'full' : 'core', settingsProblem: problems.join(' ') };
}

export function readConfig(env = process.env, { defaultDownloadDir, readStore } = {}) {
  const base = normalizeBase(env.CANVAS_BASE_URL);
  const downloads = env.CANVAS_DOWNLOAD_DIR || defaultDownloadDir;
  return {
    ...resolveToken(env, { readStore }),
    base,
    api: base ? `${base}/api/v1` : '',
    ...readLimits(env),
    tools: list(env.CANVAS_TOOLS),
    disabled: list(env.CANVAS_DISABLE_TOOLS) || new Set(),
    cacheTtl: Number(env.CANVAS_CACHE_TTL || 60) * 1000,
    tz: env.CANVAS_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
    downloadDir: downloads ? path.resolve(downloads) : downloads,
    maxChars: Math.max(5000, Number(env.CANVAS_MAX_RESPONSE_CHARS) || 100000),
    ipFamily: ipFamilyFrom(env),
  };
}
