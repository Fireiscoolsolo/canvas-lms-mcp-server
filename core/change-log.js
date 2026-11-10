// The change log: what this server changed in Canvas, one JSON line each, so a student can check what their AI did
// (get_change_log). It keeps IDs only: never message text, file paths, tokens or anything Canvas sent back.
//   { "at": "2026-11-10T12:00:00.000Z", "tool": "mark_topic_read", "outcome": "done", "confirmed_by": "not needed", "ids": { "course_id": "1", "topic_id": "3" } }
// outcome: done, failed, cancelled (the student said no) or refused (nothing was sent).
// It lives in the state folder, readable only by you on macOS and Linux, and rolls over at 1 MB keeping one old copy.
import fs from 'node:fs';
import path from 'node:path';

export const CHANGE_LOG_FILE = 'changes.jsonl';
export const OLD_CHANGE_LOG_FILE = 'changes.old.jsonl';
const LIMIT_BYTES = 1024 * 1024;
const OFF = new Set(['off', 'false', '0', 'no']);
const ON = new Set(['', 'on', 'true', '1', 'yes']);
const LOOKS_LIKE_ID = /^[\w:~.-]{1,64}$/;

/**
 * CANVAS_CHANGE_LOG: off (or false, 0, no) turns recording off. It doesn't restrict the server, so a value nobody can
 * read keeps the record on and says so, rather than quietly losing it.
 */
export function changeLogSetting(env = process.env) {
  const v = String(env.CANVAS_CHANGE_LOG ?? '').trim().toLowerCase();
  if (OFF.has(v)) return { on: false, problem: '' };
  if (ON.has(v) || /^\$\{.*\}$/.test(v)) return { on: true, problem: '' };
  return { on: true, problem: `CANVAS_CHANGE_LOG is set to "${env.CANVAS_CHANGE_LOG}", which this server can't read, so the change log stays on. Use on or off.` };
}

/** Only the arguments that are IDs (named id, or ending in _id or _ids). Anything that doesn't look like one is hidden. */
export function idsOnly(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (!(k === 'id' || /_ids?$/.test(k))) continue;
    const one = (x) => (typeof x === 'number' || (typeof x === 'string' && LOOKS_LIKE_ID.test(x)) ? String(x) : '[not an ID]');
    out[k] = Array.isArray(v) ? v.slice(0, 20).map(one) : one(v);
  }
  return out;
}

/** record() never throws: a full disk or a read-only folder must never stop a change from going through. */
export function createChangeLog({ dir, on = true, limitBytes = LIMIT_BYTES, now = () => new Date() } = {}) {
  const file = dir ? path.join(dir, CHANGE_LOG_FILE) : null;
  const old = dir ? path.join(dir, OLD_CHANGE_LOG_FILE) : null;
  const memory = []; // with no folder, this run only

  function record({ tool, outcome, confirmed_by: confirmedBy, args }) {
    if (!on) return;
    const entry = { at: now().toISOString(), tool, outcome, confirmed_by: confirmedBy, ids: idsOnly(args) };
    if (!file) {
      memory.push(entry);
      if (memory.length > 1000) memory.shift();
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify(entry)}\n`;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* no file yet */ }
      if (size > 0 && size + Buffer.byteLength(line) > limitBytes) {
        fs.rmSync(old, { force: true });
        fs.renameSync(file, old);
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch { /* remembered nowhere: the change itself still happened */ }
  }

  const linesOf = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

  /** The newest `limit` entries, newest first, across both files. */
  function read(limit = 25) {
    const all = file ? [...linesOf(old), ...linesOf(file)].map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : memory;
    return all.slice(-limit).reverse();
  }

  return { record, read, file, on };
}
