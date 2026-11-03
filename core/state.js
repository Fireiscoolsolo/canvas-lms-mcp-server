// Small JSON file of things worth remembering between runs, such as when "what's new" was last checked.
// Local keeps it in the user's app-data folder; Remote keeps it in its settings folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The per-user folder Local uses: CANVAS_STATE_DIR, else %APPDATA%, ~/Library/Application Support or ~/.config. */
export function defaultStateDir(env = process.env, platform = process.platform) {
  if (env.CANVAS_STATE_DIR) return env.CANVAS_STATE_DIR;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'canvas-lms-mcp');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'canvas-lms-mcp');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'canvas-lms-mcp');
}

/** get/set by key. With no folder it only remembers for this run. Write failures never break a tool. */
export function createStateStore(dir) {
  const file = dir ? path.join(dir, 'state.json') : null;
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
    return data;
  };
  return {
    file,
    get: (key) => load()[key],
    set(key, value) {
      const d = load();
      d[key] = value;
      if (!file) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(d, null, 2));
        fs.renameSync(`${file}.tmp`, file);
      } catch { /* read-only folder: remembered for this run only */ }
    },
  };
}
