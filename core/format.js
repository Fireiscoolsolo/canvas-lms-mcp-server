// Output helpers: field picking, tool results, friendly dates and response-size limits.

/** Project only the fields worth spending context on. */
export function pick(obj, fields) {
  if (Array.isArray(obj)) return obj.map((o) => pick(o, fields));
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const f of fields) if (obj[f] !== undefined && obj[f] !== null) out[f] = obj[f];
  return out;
}

export function omitEmpty(o) {
  if (Array.isArray(o)) return o.map(omitEmpty);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = typeof v === 'object' ? omitEmpty(v) : v;
  }
  return out;
}

/**
 * A successful tool result. `note` is shown above the data. `structured` is the machine-readable copy for tools
 * that declare an output schema, and `links` are extra content items such as resource links to saved files.
 */
export function ok(data, note, { structured, links } = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const result = { content: [{ type: 'text', text: note ? `${note}\n\n${body}` : body }] };
  if (structured !== undefined) result.structuredContent = structured;
  if (links?.length) result.content.push(...links.filter(Boolean));
  return result;
}

export function fail(msg) {
  return { content: [{ type: 'text', text: String(msg) }], isError: true };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const iso = (d) => new Date(d).toISOString();
export const daysFromNow = (n, now = Date.now()) => new Date(now + n * 86400000);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "in 3 hours", "in 2 days", "5 days ago", "in 20 minutes". */
export function relativeTime(ts, now = Date.now()) {
  if (!ts) return null;
  const diff = new Date(ts).getTime() - now;
  if (Number.isNaN(diff)) return null;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const span = mins < 60 ? plural(Math.max(1, mins), 'minute') : hours < 48 ? plural(hours, 'hour') : plural(days, 'day');
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

/** Date formatters bound to one time zone. */
export function makeDates(tz) {
  const fmt = (ts, opts) => {
    if (!ts) return null;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    try { return d.toLocaleString('en-US', { timeZone: tz, ...opts }); } catch { return d.toISOString(); }
  };
  /** "Fri, Nov 7, 2026, 11:59 PM" */
  const localize = (ts) => fmt(ts, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  /** "Fri, Nov 7, 11:59 PM (in 2 days)" */
  const friendly = (ts, now = Date.now()) => {
    if (!ts) return null;
    const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
    const base = fmt(ts, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
    const rel = relativeTime(ts, now);
    return rel ? `${base} (${rel})` : base;
  };
  /** Calendar day in the user's zone, e.g. "2026-11-07", for grouping. */
  const dayKey = (ts) => {
    try { return new Date(ts).toLocaleDateString('en-CA', { timeZone: tz }); } catch { return new Date(ts).toISOString().slice(0, 10); }
  };
  /** "Fri, Nov 7" */
  const dayLabel = (ts) => fmt(ts, { weekday: 'short', month: 'short', day: 'numeric' });
  return { localize, friendly, relativeDue: relativeTime, dayKey, dayLabel };
}

// Date fields that get a readable "_local" companion in list and detail results.
const DATE_FIELDS = { due_at: 'due_local', lock_at: 'lock_local', unlock_at: 'unlock_local', start_at: 'start_local', end_at: 'end_local', posted_at: 'posted_local', todo_date: 'todo_local' };

/** Add "due_local: Fri, Nov 7, 11:59 PM (in 2 days)" next to Canvas timestamps, on an object or an array of them. */
export function addLocalDates(data, friendly) {
  const one = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    let c = o;
    for (const [field, local] of Object.entries(DATE_FIELDS)) {
      if (typeof o[field] === 'string' && o[local] === undefined) {
        if (c === o) c = { ...o };
        c[local] = friendly(o[field]);
      }
    }
    return c;
  };
  return Array.isArray(data) ? data.map(one) : one(data);
}

// ---------------------------------------------------------------------------
// Size control
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;

/**
 * Slice one page out of a fetched list. Fetch one item more than the pages you need: an extra item is how we know
 * there is more, since Canvas gives no total.
 */
export function pageOf(items, { page = 1, size = DEFAULT_PAGE_SIZE }) {
  const start = (page - 1) * size;
  const rows = items.slice(start, start + size);
  const more = items.length > start + size;
  let note = null;
  if (!rows.length && page > 1) note = `Page ${page} is empty: there are only ${items.length} items.`;
  else if (more) note = `Showing items ${start + 1}-${start + rows.length}. There are more: call again with page=${page + 1} (or a larger limit) to see them.`;
  else if (page > 1) note = `Showing items ${start + 1}-${start + rows.length} (the last page).`;
  return { rows, note, more };
}

/**
 * Last-resort cap on the text of a result. Lists are paged before this point, so it only trims very large single
 * items, such as a long page body. The cut is marked so the model knows to narrow the request.
 */
/**
 * Structured results have a schema, so they can't be cut off mid-way like text. When one is too long, its longest list
 * keeps as many items as fit. Returns { value, cut }, where cut says what was kept, or null when nothing was.
 */
export function trimToFit(value, max) {
  const size = (v) => JSON.stringify(v).length;
  if (!max || value === undefined || size(value) <= max) return { value, cut: null };
  const copy = structuredClone(value);
  const lists = [];
  const walk = (v) => {
    if (Array.isArray(v)) { lists.push(v); v.forEach(walk); } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(copy);
  if (!lists.length) return { value, cut: null };
  const longest = lists.reduce((a, b) => (size(b) > size(a) ? b : a));
  const total = longest.length;
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const rest = longest.splice(mid);
    const fits = size(copy) <= max;
    longest.push(...rest);
    if (fits) lo = mid; else hi = mid - 1;
  }
  longest.splice(lo);
  return { value: copy, cut: `${lo} of ${total} items` };
}

export function capText(text, max) {
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Cut off here: the full answer was ${text.length.toLocaleString('en-US')} characters. Ask for fewer items, a page, or a narrower date range.]`;
}
