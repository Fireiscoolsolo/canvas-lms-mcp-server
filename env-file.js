// Read and change values in the settings folder's .env without disturbing the other lines or comments.
// Every change backs the file up first (.env.backup-<time>). Used by rotate-password and totp-setup.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export const readEnv = (file) => (fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file, 'utf8')) : null);

/**
 * Write a file that holds secrets or sign-ins: whole or not at all (a temp file, then a rename, so a crash never leaves
 * half a file), and readable only by you on Linux and macOS. Windows ignores the mode; there the folder's own
 * permissions apply, which is why the settings folder belongs in your user profile.
 */
export function writePrivate(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600); // in case an old temp file had a looser mode
  fs.renameSync(tmp, file);
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const quote = (v) => (/[\s#"'=]/.test(v) ? `"${String(v).replace(/"/g, '\\"')}"` : String(v));

/**
 * Set (or with value null, remove) keys in a .env file. Returns the backup's path.
 * values: { KEY: 'new value' | null }
 */
export function setEnvValues(file, values, now = new Date()) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const backup = before ? path.join(path.dirname(file), `.env.backup-${stamp(now)}`) : null;
  if (backup) writePrivate(backup, before);
  const lines = before.split(/\r?\n/);
  const left = new Map(Object.entries(values));
  const out = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && left.has(m[1])) {
      const v = left.get(m[1]);
      left.delete(m[1]);
      if (v !== null && v !== undefined) out.push(`${m[1]}=${quote(v)}`);
      continue;
    }
    out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const [k, v] of left) if (v !== null && v !== undefined) out.push(`${k}=${quote(v)}`);
  writePrivate(file, `${out.join('\n')}\n`);
  return backup;
}
