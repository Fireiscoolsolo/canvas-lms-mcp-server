// iCalendar (.ics) files of Canvas deadlines, for importing into Google Calendar, Apple Calendar or Outlook.
// Pure: takes events, returns text (RFC 5545: CRLF lines, escaped text, lines folded at 75 bytes).

const pad = (n) => String(n).padStart(2, '0');
const utc = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}${pad(x.getUTCSeconds())}Z`;
};
export const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold one content line to 75 bytes per physical line, never splitting a multi-byte character. */
export function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * events: [{ uid, title, start, end?, description?, url?, location? }] with Date or ISO times.
 * remindMinutes adds a reminder that many minutes before each event (0 for none).
 */
export function buildIcs(events, { name = 'Canvas deadlines', now = new Date(), remindMinutes = 0 } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//canvas-lms-mcp//deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`];
  for (const e of events) {
    if (!e.start) continue;
    const start = new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(start.getTime() + 30 * 60000);
    lines.push('BEGIN:VEVENT',
      `UID:${escapeText(e.uid)}`,
      `DTSTAMP:${utc(now)}`,
      `DTSTART:${utc(start)}`,
      `DTEND:${utc(end)}`,
      `SUMMARY:${escapeText(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.url) lines.push(`URL:${String(e.url).replace(/[\r\n]/g, '')}`);
    if (remindMinutes > 0) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.title)}`, `TRIGGER:-PT${Math.round(remindMinutes)}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** A Canvas deadline as a calendar event: a 30-minute block that ends at the due time. */
export function deadlineEvent({ id, type = 'item', title, course, due, url, points }, host = 'canvas') {
  const dueAt = new Date(due);
  return {
    uid: `${type}-${id}@${host}`,
    title: `Due: ${title}${course ? ` (${course})` : ''}`,
    start: new Date(dueAt.getTime() - 30 * 60000),
    end: dueAt,
    description: [course, points ? `${points} points` : null, url].filter(Boolean).join('\n'),
    url,
  };
}
