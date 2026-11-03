// Read and change values in the settings folder's .env without disturbing the other lines or comments.
// Every change backs the file up first (.env.backup-<time>). Used by rotate-password and totp-setup.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export const readEnv = (file) => (fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file, 'utf8')) : null);

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const quote = (v) => (/[\s#"'=]/.test(v) ? `"${String(v).replace(/"/g, '\\"')}"` : String(v));

/**
 * Set (or with value null, remove) keys in a .env file. Returns the backup's path.
 * values: { KEY: 'new value' | null }
 */
export function setEnvValues(file, values, now = new Date()) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const backup = before ? path.join(path.dirname(file), `.env.backup-${stamp(now)}`) : null;
  if (backup) fs.writeFileSync(backup, before);
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
  fs.writeFileSync(file, `${out.join('\n')}\n`);
  return backup;
}
