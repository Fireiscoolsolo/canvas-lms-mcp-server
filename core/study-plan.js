// Proposes study blocks before each deadline: estimates how long each item needs, then spreads that time over the
// days before it is due, inside a daily time window, around busy times. Pure (times are this computer's local
// time), so it is unit tested without Canvas.

const HOUR = 3600000;
const QUARTER = 15 * 60000;

/** Rough hours of work for one planner item, from its type, title and points. Shown to the user as an estimate. */
export function estimateHours({ title = '', type = '', points } = {}) {
  const t = String(title).toLowerCase();
  if (type === 'planner_note' || type === 'calendar_event') return 0;
  if (/\b(final exam|midterm|exam|test)\b/.test(t)) return 6;
  if (type === 'quiz' || /\bquiz\b/.test(t)) return 1.5;
  if (type === 'discussion_topic' || /\bdiscussion\b/.test(t)) return 1;
  const p = Number(points || 0);
  if (/\b(project|paper|essay|report|presentation)\b/.test(t)) return Math.max(4, Math.min(10, Math.round(p / 15) || 4));
  if (p <= 10) return 1;
  if (p <= 25) return 1.5;
  if (p <= 50) return 2;
  if (p <= 100) return 3;
  return 5;
}

/** "16:00" or "4" -> minutes after midnight. */
export function parseClock(value, fallback) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  return h <= 24 && min < 60 ? h * 60 + min : fallback;
}

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; };
const atMinutes = (day, minutes) => { const d = new Date(day); d.setHours(0, minutes, 0, 0); return d.getTime(); };

/**
 * items: [{ title, type, points, due_at, course, course_id, hours? }]
 * Returns { blocks: [{ title, start, end, for, course, course_id, due_at }], items: [per-item summary] }.
 * Work starts as early as possible and is spread one block per day per item, earliest deadline first, so a big
 * assignment is worked on over several days instead of crammed into the night before.
 */
export function planStudyBlocks(items, {
  now = new Date(), dayStart = '16:00', dayEnd = '21:00', maxHoursPerDay = 3, blockMinutes = 60, skipWeekends = false, busy = [],
} = {}) {
  const openMin = parseClock(dayStart, 16 * 60);
  const closeMin = parseClock(dayEnd, 21 * 60);
  const block = Math.max(15, Math.min(240, Number(blockMinutes) || 60)) * 60000;
  const cap = Math.max(0.5, Number(maxHoursPerDay) || 3) * HOUR;
  const nowMs = Math.ceil(new Date(now).getTime() / QUARTER) * QUARTER;
  const busySpans = busy.map((b) => [new Date(b.start).getTime(), new Date(b.end || b.start).getTime()]).filter(([s, e]) => e > s);
  const planned = [];
  const usedPerDay = new Map();
  const overlaps = (s, e) => busySpans.some(([bs, be]) => s < be && e > bs) || planned.some((p) => s < p.end && e > p.start);

  function slotOn(day, limit) {
    const used = usedPerDay.get(day.getTime()) || 0;
    if (used + block > cap) return null;
    const close = Math.min(atMinutes(day, closeMin), limit);
    for (let s = Math.max(atMinutes(day, openMin), nowMs); s + block <= close; s += QUARTER) {
      if (!overlaps(s, s + block)) return s;
    }
    return null;
  }

  const todo = items
    .filter((i) => i.due_at && new Date(i.due_at).getTime() > nowMs)
    .map((i) => ({ ...i, hours: i.hours ?? estimateHours(i) }))
    .filter((i) => i.hours > 0)
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));

  const blocks = [];
  const summary = [];
  for (const item of todo) {
    const due = new Date(item.due_at).getTime();
    const limit = due - 30 * 60000; // finish at least half an hour before it is due
    const days = [];
    for (let d = startOfDay(nowMs); d.getTime() <= due; d.setDate(d.getDate() + 1)) {
      if (skipWeekends && (d.getDay() === 0 || d.getDay() === 6)) continue;
      days.push(new Date(d));
    }
    const needed = Math.ceil((item.hours * HOUR) / block);
    let got = 0;
    let progress = true;
    while (got < needed && progress) {
      progress = false;
      for (const day of days) {
        if (got >= needed) break;
        const s = slotOn(day, limit);
        if (s === null) continue;
        planned.push({ start: s, end: s + block });
        usedPerDay.set(day.getTime(), (usedPerDay.get(day.getTime()) || 0) + block);
        blocks.push({ title: `Study: ${item.title}`, start: new Date(s).toISOString(), end: new Date(s + block).toISOString(), for: item.title, course: item.course, course_id: item.course_id, due_at: item.due_at });
        got++;
        progress = true;
      }
    }
    const scheduled = (got * block) / HOUR;
    summary.push({
      title: item.title, course: item.course, due_at: item.due_at,
      estimated_hours: item.hours, scheduled_hours: Number(scheduled.toFixed(2)),
      unscheduled_hours: Number(Math.max(0, item.hours - scheduled).toFixed(2)),
    });
  }
  blocks.sort((a, b) => new Date(a.start) - new Date(b.start));
  return { blocks, items: summary };
}
