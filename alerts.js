// Phone alerts for the Remote Edition: new grades, new announcements, work due soon, a Canvas token that is about to
// expire, and (when turned on) new assignments, teacher comments, new inbox messages, a grade dropping below a line
// you pick, and sign-ins to your server. Sent through ntfy, Discord, Telegram, Slack, Microsoft Teams and/or
// Pushover, as they happen or as one daily digest, held back during quiet hours. Only the computer that is serving
// runs index.js, so a group of computers never sends the same alert twice.
import fs from 'node:fs';
import path from 'node:path';

// Where the "already told you about this" state lives in your Canvas custom-data store, so every computer shares it.
const NAMESPACE = 'io.github.fireiscoolsolo.canvas-mcp';
const STATE_SCOPE = '/users/self/custom_data/alerts';
const ALL_TYPES = ['grades', 'announcements', 'due', 'token', 'assignments', 'comments', 'inbox', 'grade_drop', 'security'];
const DEFAULT_TYPES = ['grades', 'announcements', 'due', 'token'];
// Sent right away even in digest mode or quiet hours, because they can't wait.
const URGENT = new Set(['due', 'token', 'security']);
const TAGS = { grades: 'mortar_board', announcements: 'loudspeaker', due: 'alarm_clock', token: 'key', test: 'white_check_mark', assignments: 'memo', comments: 'speech_balloon', inbox: 'envelope', grade_drop: 'chart_with_downwards_trend', security: 'lock', digest: 'sunrise' };
const DAY = 86400000;
const GRADE_SUMMARY_AFTER = 3;
const NEW_ITEM_DAYS = 60;

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
/** "7:30" -> "07:30", or null. */
export function parseClock(v) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(v || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) return null;
  return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function alertSettings(env = process.env) {
  const types = (env.CANVAS_ALERTS ? list(env.CANVAS_ALERTS).map((t) => t.toLowerCase()) : DEFAULT_TYPES).filter((t) => ALL_TYPES.includes(t));
  const digest = parseClock(env.CANVAS_ALERTS_DIGEST);
  const [qs, qe] = String(env.CANVAS_ALERTS_QUIET || '').split('-').map(parseClock);
  const mode = ['instant', 'digest', 'both'].includes(String(env.CANVAS_ALERTS_MODE || '').toLowerCase()) ? String(env.CANVAS_ALERTS_MODE).toLowerCase() : digest ? 'both' : 'instant';
  return {
    ntfyTopic: String(env.CANVAS_ALERTS_NTFY_TOPIC || '').trim(),
    ntfyServer: String(env.CANVAS_ALERTS_NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, ''),
    discordWebhook: String(env.CANVAS_ALERTS_DISCORD_WEBHOOK || '').trim(),
    telegramToken: String(env.CANVAS_ALERTS_TELEGRAM_TOKEN || '').trim(),
    telegramChatId: String(env.CANVAS_ALERTS_TELEGRAM_CHAT_ID || '').trim(),
    slackWebhook: String(env.CANVAS_ALERTS_SLACK_WEBHOOK || '').trim(),
    teamsWebhook: String(env.CANVAS_ALERTS_TEAMS_WEBHOOK || '').trim(),
    pushoverToken: String(env.CANVAS_ALERTS_PUSHOVER_TOKEN || '').trim(),
    pushoverUser: String(env.CANVAS_ALERTS_PUSHOVER_USER || '').trim(),
    types: new Set(types),
    intervalMinutes: Math.max(5, Number(env.CANVAS_ALERTS_INTERVAL_MINUTES) || 15),
    dueHours: Math.max(1, Number(env.CANVAS_ALERTS_DUE_HOURS) || 24),
    tokenDays: 5,
    gradeBelow: Math.min(100, Math.max(1, Number(env.CANVAS_ALERTS_GRADE_BELOW) || 70)),
    digest,
    mode: digest ? mode : 'instant',
    quiet: qs && qe ? { start: qs, end: qe } : null,
    courses: list(env.CANVAS_ALERTS_COURSES).map((s) => s.toLowerCase()),
    skipCourses: list(env.CANVAS_ALERTS_SKIP_COURSES).map((s) => s.toLowerCase()),
    tz: env.CANVAS_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

const plain = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const when = (d) => d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The local date ("2026-11-02") and minutes after midnight in the user's time zone. */
export function localClock(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function inQuietHours(now, settings) {
  if (!settings.quiet) return false;
  const m = localClock(now, settings.tz).minutes;
  const s = minutesOf(settings.quiet.start), e = minutesOf(settings.quiet.end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

/** Whether alerts about this course should be sent, from CANVAS_ALERTS_COURSES / CANVAS_ALERTS_SKIP_COURSES. */
export function courseAllowed(id, name, settings) {
  const n = String(name || '').toLowerCase();
  const hit = (entry) => entry === String(id) || (entry.length > 2 && n.includes(entry));
  if (settings.courses.length && !settings.courses.some(hit)) return false;
  return !settings.skipCourses.some(hit);
}

/**
 * Decide which alerts to send. Pure: takes what Canvas returned plus the saved state and returns the alerts and
 * the next state. The very first run only records a starting point, so nothing old is announced.
 */
export function collectAlerts({ stream = [], planner = [], upcoming = [], conversations = [], grades = [], tokens = [], me = null, courseNames = {}, state = {}, now = new Date(), settings, baseUrl = '' }) {
  const alerts = [];
  const next = { ...state, last_check: now.toISOString(), due_alerted: { ...(state.due_alerted || {}) }, token_alerted_on: state.token_alerted_on || null };
  const since = state.last_check ? new Date(state.last_check) : null;
  const course = (id) => courseNames[String(id)] || 'one of your courses';
  const allowed = (id, name) => courseAllowed(id, name || courseNames[String(id)], settings);
  const absolute = (url) => (!url ? undefined : /^https?:\/\//.test(url) ? url : `${baseUrl}${url}`);

  if (since) {
    const gradeAlerts = [];
    for (const s of stream) {
      const at = new Date(s.updated_at || s.created_at);
      if (!(at > since) || !allowed(s.course_id)) continue;
      if (s.type === 'Submission' && settings.types.has('grades') && (s.score != null || s.grade)) {
        const pts = s.assignment?.points_possible;
        const shown = s.score != null ? `${s.score}${pts ? `/${pts}` : ''}` : s.grade;
        const letter = s.grade && s.score != null && String(s.grade) !== String(s.score) ? ` (${s.grade})` : '';
        gradeAlerts.push({ type: 'grades', title: `New grade in ${course(s.course_id)}`, message: `${s.assignment?.name || s.title || 'An assignment'}: ${shown}${letter}`, url: absolute(s.html_url) });
      } else if (s.type === 'Announcement' && settings.types.has('announcements')) {
        const body = plain(s.message);
        alerts.push({ type: 'announcements', title: `Announcement in ${course(s.course_id)}`, message: clip(`${s.title}${body ? `: ${body}` : ''}`, 300), url: absolute(s.html_url) });
      }
    }
    // Lots of grades at once (end of term) become one summary instead of a burst of notifications.
    if (gradeAlerts.length > GRADE_SUMMARY_AFTER) {
      alerts.unshift({ type: 'grades', title: `${gradeAlerts.length} new grades posted`, message: clip(gradeAlerts.map((g) => `${g.title.replace('New grade in ', '')}: ${g.message}`).join('\n'), 900), url: `${baseUrl}/grades` });
    } else {
      alerts.unshift(...gradeAlerts);
    }

    if (settings.types.has('comments')) {
      for (const s of stream) {
        if (s.type !== 'Submission' || !allowed(s.course_id)) continue;
        for (const c of s.submission_comments || []) {
          if (!(new Date(c.created_at) > since) || (me && String(c.author_id) === String(me))) continue;
          alerts.push({ type: 'comments', title: `New comment from ${c.author_name || 'your teacher'}`, message: clip(`${s.assignment?.name || s.title || 'An assignment'} (${course(s.course_id)}): ${plain(c.comment)}`, 300), url: absolute(s.html_url) });
        }
      }
    }

    if (settings.types.has('inbox')) {
      for (const c of conversations) {
        if (!(new Date(c.last_message_at) > since)) continue;
        if (c.last_authored_message_at && c.last_authored_message_at === c.last_message_at) continue;
        const from = (c.participants || []).filter((p) => !me || String(p.id) !== String(me)).map((p) => p.name).slice(0, 2).join(', ');
        alerts.push({ type: 'inbox', title: `New message${from ? ` from ${from}` : ''}`, message: clip(`${c.subject || '(no subject)'}: ${plain(c.last_message)}`, 300), url: `${baseUrl}/conversations` });
      }
    }
  }

  if (settings.types.has('assignments')) {
    const kinds = { assignment: 'assignment', quiz: 'quiz', discussion_topic: 'discussion' };
    const known = new Set(state.known_items || []);
    const seeded = Array.isArray(state.known_items);
    const current = upcoming.filter((i) => kinds[i.plannable_type]).map((i) => ({ key: `${i.plannable_type}:${i.plannable_id}`, i }));
    if (seeded) {
      for (const { key, i } of current) {
        if (known.has(key) || !allowed(i.course_id, i.context_name)) continue;
        const due = i.plannable?.due_at || i.plannable_date;
        const pts = i.plannable?.points_possible;
        alerts.push({ type: 'assignments', title: `New ${kinds[i.plannable_type]} in ${i.context_name || course(i.course_id)}`, message: `${i.plannable?.title || 'Untitled'}${due ? `, due ${when(new Date(due))}` : ''}${pts ? ` (${pts} points)` : ''}`, url: absolute(i.html_url) });
      }
    }
    next.known_items = [...new Set([...current.map((c) => c.key), ...known])].slice(0, 3000);
  }

  if (settings.types.has('grade_drop')) {
    const alerted = { ...(state.grade_alerted || {}) };
    for (const g of grades) {
      if (g.score === null || g.score === undefined || !allowed(g.course_id, g.name)) continue;
      const key = String(g.course_id);
      if (g.score < settings.gradeBelow) {
        if (alerted[key] === undefined || g.score <= alerted[key] - 2) {
          alerts.push({ type: 'grade_drop', title: `${g.name || course(g.course_id)} is at ${g.score}%`, message: `Your grade dropped below ${settings.gradeBelow}%. Ask your AI "what do I need on the rest of ${g.name || 'this course'}?" to plan a comeback.`, url: `${baseUrl}/courses/${g.course_id}/grades` });
          alerted[key] = g.score;
        }
      } else {
        delete alerted[key];
      }
    }
    next.grade_alerted = alerted;
  }

  if (settings.types.has('due')) {
    const horizon = now.getTime() + settings.dueHours * 3600000;
    for (const i of planner) {
      const due = i.plannable?.due_at || i.plannable_date;
      if (!due || !allowed(i.course_id, i.context_name)) continue;
      const d = new Date(due);
      if (d.getTime() < now.getTime() || d.getTime() > horizon) continue;
      const sub = i.submissions || {};
      if (sub.submitted || sub.excused || sub.graded || i.planner_override?.marked_complete) continue;
      const key = String(i.plannable_id);
      if (next.due_alerted[key] === due) continue;
      next.due_alerted[key] = due;
      const hours = Math.max(1, Math.round((d.getTime() - now.getTime()) / 3600000));
      alerts.push({
        type: 'due',
        title: `Due in ${hours} hour${hours === 1 ? '' : 's'}: ${i.plannable?.title || 'an assignment'}`,
        message: `${i.context_name || course(i.course_id)}, due ${when(d)}. Not submitted yet.`,
        url: absolute(i.html_url),
      });
    }
    for (const [key, due] of Object.entries(next.due_alerted)) if (new Date(due).getTime() < now.getTime() - 7 * DAY) delete next.due_alerted[key];
  }

  if (settings.types.has('token')) {
    const today = now.toISOString().slice(0, 10);
    const expiring = tokens
      .filter((t) => t.expires_at && (!t.workflow_state || t.workflow_state === 'active'))
      .map((t) => ({ at: new Date(t.expires_at), days: (new Date(t.expires_at).getTime() - now.getTime()) / DAY }))
      .filter((t) => t.days >= 0 && t.days <= settings.tokenDays)
      .sort((a, b) => a.days - b.days)[0];
    if (expiring && next.token_alerted_on !== today) {
      next.token_alerted_on = today;
      const days = Math.ceil(expiring.days);
      alerts.push({
        type: 'token',
        title: 'Your Canvas token expires soon',
        message: `A Canvas access token expires in ${days} day${days === 1 ? '' : 's'} (${when(expiring.at)}). If it's the one this server uses, make a new one in Canvas (Account → Settings → New Access Token) and put it in your .env, or use Auto update in the setup app.`,
        url: `${baseUrl}/profile/settings`,
      });
    }
  }
  return { alerts, state: next };
}

/**
 * Apply digest mode and quiet hours. In digest mode only urgent alerts go out right away (the rest wait for the
 * digest). During quiet hours non-urgent alerts are held, then sent together (as one summary if there are many).
 */
export function planDelivery({ alerts, state = {}, settings, now = new Date() }) {
  const next = { ...state };
  const list = settings.mode === 'digest' ? alerts.filter((a) => URGENT.has(a.type)) : alerts;
  if (inQuietHours(now, settings)) {
    next.queued = [...(state.queued || []), ...list.filter((a) => a.type !== 'security')].slice(-50);
    return { send: list.filter((a) => a.type === 'security'), state: next };
  }
  const held = state.queued || [];
  next.queued = [];
  const summary = held.length > 3
    ? [{ type: 'digest', title: `While you were away: ${held.length} alerts`, message: clip(held.map((a) => `• ${a.title}`).join('\n'), 900) }]
    : held;
  return { send: [...summary, ...list], state: next };
}

export function digestDue(now, settings, state = {}) {
  if (!settings.digest || settings.mode === 'instant') return false;
  const { date, minutes } = localClock(now, settings.tz);
  return minutes >= minutesOf(settings.digest) && state.digest_sent_on !== date;
}

/** One message with the day ahead: what's due today and tomorrow, new grades, missing work and unread messages. */
export function buildDigest({ planner = [], stream = [], missingCount = 0, unreadCount = null, courseNames = {}, now = new Date(), settings, baseUrl = '' }) {
  const { date } = localClock(now, settings.tz);
  const tomorrow = localClock(new Date(now.getTime() + DAY), settings.tz).date;
  const dayOf = (d) => localClock(new Date(d), settings.tz).date;
  const due = planner.filter((i) => (i.plannable?.due_at || i.plannable_date) && !i.submissions?.submitted && courseAllowed(i.course_id, i.context_name, settings));
  const line = (i) => `${i.plannable?.title || 'Untitled'} (${i.context_name || courseNames[String(i.course_id)] || 'course'}, ${new Date(i.plannable?.due_at || i.plannable_date).toLocaleTimeString('en-US', { timeZone: settings.tz, hour: 'numeric', minute: '2-digit' })})`;
  const today = due.filter((i) => dayOf(i.plannable?.due_at || i.plannable_date) === date);
  const tmr = due.filter((i) => dayOf(i.plannable?.due_at || i.plannable_date) === tomorrow);
  const grades = stream.filter((s) => s.type === 'Submission' && (s.score != null || s.grade) && now - new Date(s.updated_at || s.created_at) < DAY);
  const parts = [
    today.length ? `Due today: ${today.map(line).join('; ')}` : 'Nothing due today.',
    tmr.length ? `Due tomorrow: ${tmr.map(line).join('; ')}` : null,
    grades.length ? `New grades: ${grades.map((g) => `${g.assignment?.name || g.title} ${g.score ?? g.grade}${g.assignment?.points_possible ? `/${g.assignment.points_possible}` : ''}`).join('; ')}` : null,
    missingCount ? `Missing work: ${missingCount}` : null,
    unreadCount ? `Unread messages: ${unreadCount}` : null,
  ].filter(Boolean);
  return { type: 'digest', title: today.length ? `Your Canvas day: ${today.length} due today` : 'Your Canvas day', message: clip(parts.join('\n'), 900), url: `${baseUrl}/` };
}

const slack = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const CHANNELS = [
  ['ntfy', (s) => s.ntfyTopic, (a, s) => [`${s.ntfyServer}/`, json({
    topic: s.ntfyTopic, title: a.title, message: a.message, click: a.url,
    tags: [TAGS[a.type] || 'bell'], priority: URGENT.has(a.type) ? 4 : 3,
  })]],
  ['Discord', (s) => s.discordWebhook, (a, s) => [s.discordWebhook, json({ content: clip(`**${a.title}**\n${a.message}${a.url ? `\n<${a.url}>` : ''}`, 1900), allowed_mentions: { parse: [] } })]],
  ['Telegram', (s) => s.telegramToken && s.telegramChatId, (a, s) => [`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, json({ chat_id: s.telegramChatId, text: clip(`${a.title}\n${a.message}${a.url ? `\n${a.url}` : ''}`, 4000), disable_web_page_preview: true })]],
  ['Slack', (s) => s.slackWebhook, (a, s) => [s.slackWebhook, json({ text: clip(`*${slack(a.title)}*\n${slack(a.message)}${a.url ? `\n<${a.url}|Open in Canvas>` : ''}`, 3000) })]],
  ['Teams', (s) => s.teamsWebhook, (a, s) => [s.teamsWebhook, json({
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [{ type: 'TextBlock', text: a.title, weight: 'Bolder', wrap: true }, { type: 'TextBlock', text: a.message, wrap: true }],
        actions: a.url ? [{ type: 'Action.OpenUrl', title: 'Open in Canvas', url: a.url }] : [],
      },
    }],
  })]],
  ['Pushover', (s) => s.pushoverToken && s.pushoverUser, (a, s) => ['https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: s.pushoverToken, user: s.pushoverUser, title: clip(a.title, 250), message: clip(a.message, 1024), ...(a.url ? { url: a.url, url_title: 'Open in Canvas' } : {}), priority: URGENT.has(a.type) ? '1' : '0' }).toString(),
  }]],
];

/** Names of the channels that are set up. */
export const channelsOf = (s) => CHANNELS.filter(([, on]) => on(s)).map(([name]) => name);
export const alertsEnabled = (s) => channelsOf(s).length > 0 && s.types.size > 0;

/** Send one alert to every configured channel. Throws if none of them accepted it. */
export async function deliver(alert, settings, fetchImpl = fetch) {
  const sends = CHANNELS.filter(([, on]) => on(settings)).map(([name, , build]) => [name, (async () => fetchImpl(...build(alert, settings)))()]);
  const results = await Promise.allSettled(sends.map(([, p]) => p));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? `${sends[i][0]}: ${r.reason.message}` : r.value.ok ? null : `${sends[i][0]}: HTTP ${r.value.status}`))
    .filter(Boolean);
  if (failed.length === sends.length) throw new Error(`Alert not delivered (${failed.join('; ')})`);
  return failed;
}

/** What the status page and `status` command show about alerts. No secrets. */
export function describeAlerts(settings) {
  return {
    on: alertsEnabled(settings),
    channels: channelsOf(settings),
    types: [...settings.types],
    every_minutes: settings.intervalMinutes,
    digest: settings.digest ? `${settings.digest}${settings.mode === 'digest' ? ' (only urgent alerts in between)' : ''}` : null,
    quiet: settings.quiet ? `${settings.quiet.start} to ${settings.quiet.end}` : null,
  };
}

/** Saved state: in your Canvas custom-data store so every computer shares it, with a local copy as a fallback. */
function stateStore(canvas, file) {
  return {
    async load() {
      try {
        const r = await canvas.get(STATE_SCOPE, { ns: NAMESPACE }, { ttl: 0 });
        if (r && r.data) return r.data;
      } catch { /* not saved in Canvas yet, or the school turned custom data off */ }
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
    },
    async save(state) {
      try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* read-only folder; Canvas copy still saved */ }
      await canvas.put(STATE_SCOPE, { ns: NAMESPACE, data: state }).catch(() => {});
    },
  };
}

export async function gatherAlertData(canvas, settings, now, { digest = false } = {}) {
  const want = (t) => settings.types.has(t);
  const iso = (ms) => new Date(ms).toISOString();
  const stream = want('grades') || want('announcements') || want('comments') || digest
    ? await canvas.paginate('/users/self/activity_stream', { only_active_courses: true }, { max: 100, ttl: 0 }).catch(() => [])
    : [];
  const planner = want('due') || digest
    ? await canvas.paginate('/planner/items', { start_date: iso(now.getTime()), end_date: iso(now.getTime() + Math.max(settings.dueHours, digest ? 48 : 0) * 3600000), filter: 'incomplete_items' }, { max: 100, ttl: 0 }).catch(() => [])
    : [];
  const upcoming = want('assignments')
    ? await canvas.paginate('/planner/items', { start_date: iso(now.getTime() - DAY), end_date: iso(now.getTime() + NEW_ITEM_DAYS * DAY) }, { max: 300, ttl: 0 }).catch(() => [])
    : [];
  const me = want('token') || want('comments') || want('inbox') ? await canvas.get('/users/self', null, { ttl: 3600000 }).catch(() => null) : null;
  const tokens = want('token') && me ? await canvas.paginate(`/users/${me.id}/user_generated_tokens`, {}, { max: 100, ttl: 0 }).catch(() => []) : [];
  const conversations = want('inbox') ? await canvas.paginate('/conversations', { scope: 'unread' }, { max: 30, ttl: 0 }).catch(() => []) : [];
  const courses = await canvas.paginate('/courses', { enrollment_state: 'active', include: want('grade_drop') ? ['total_scores'] : undefined }, { max: 60, ttl: want('grade_drop') ? 0 : 600000 }).catch(() => []);
  const grades = want('grade_drop') ? courses.map((c) => {
    const e = (c.enrollments || []).find((x) => x.type === 'student') || {};
    return { course_id: c.id, name: c.name, score: typeof e.computed_current_score === 'number' ? e.computed_current_score : null };
  }) : [];
  const extra = digest ? {
    missingCount: (await canvas.paginate('/users/self/missing_submissions', { filter: ['submittable'] }, { max: 100, ttl: 0 }).catch(() => [])).length,
    unreadCount: Number((await canvas.get('/conversations/unread_count', null, { ttl: 0 }).catch(() => null))?.unread_count) || 0,
  } : {};
  return { stream, planner, upcoming, conversations, grades, tokens, me: me?.id ?? null, courseNames: Object.fromEntries(courses.map((c) => [String(c.id), c.name])), ...extra };
}

/** Start checking every few minutes. Returns null when no alert channel is set up. */
export function startAlerts({ canvas, log, baseUrl, env = process.env, stateFile = path.resolve('alerts-state.json'), fetchImpl = fetch }) {
  const settings = alertSettings(env);
  if (!alertsEnabled(settings)) {
    log('phone alerts off (set an alert channel such as CANVAS_ALERTS_NTFY_TOPIC in .env to turn them on)');
    return null;
  }
  const store = stateStore(canvas, stateFile);
  const send = async (list) => {
    let sent = 0;
    for (const a of list) {
      try { await deliver(a, settings, fetchImpl); sent++; } catch (e) { log(e.message); }
    }
    return sent;
  };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const state = await store.load();
      const withDigest = digestDue(now, settings, state);
      const data = await gatherAlertData(canvas, settings, now, { digest: withDigest });
      const collected = collectAlerts({ ...data, state, now, settings, baseUrl });
      const planned = planDelivery({ alerts: collected.alerts, state: collected.state, settings, now });
      const next = planned.state;
      const out = [...planned.send];
      if (withDigest) {
        out.push(buildDigest({ ...data, now, settings, baseUrl }));
        next.digest_sent_on = localClock(now, settings.tz).date;
      }
      const sent = await send(out);
      await store.save(next);
      if (sent) log(`sent ${sent} phone alert${sent === 1 ? '' : 's'}`);
    } catch (e) {
      log(`alert check failed: ${e.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 30000);
  const timer = setInterval(tick, settings.intervalMinutes * 60000);
  log(`phone alerts on: ${[...settings.types].join(', ')} every ${settings.intervalMinutes} min via ${channelsOf(settings).join(', ')}${settings.digest ? `, digest at ${settings.digest}` : ''}${settings.quiet ? `, quiet ${settings.quiet.start}-${settings.quiet.end}` : ''}`);
  return {
    tick,
    stop: () => clearInterval(timer),
    settings,
    /** Send an alert straight away (sign-ins and lockouts), if that alert type is turned on. */
    notify: (alert) => (settings.types.has(alert.type) ? send([alert]) : Promise.resolve(0)),
  };
}

/** `canvas-lms-mcp-remote test-alert`: send one test alert using the settings in .env. */
export async function sendTestAlert(env = process.env, fetchImpl = fetch) {
  const settings = alertSettings(env);
  if (!alertsEnabled(settings)) throw new Error('No alert channel is set. Add one to your .env, for example CANVAS_ALERTS_NTFY_TOPIC or CANVAS_ALERTS_DISCORD_WEBHOOK.');
  const failed = await deliver({ type: 'test', title: 'Canvas alerts are working', message: `You will get alerts here for: ${[...settings.types].join(', ')}.` }, settings, fetchImpl);
  return { channels: channelsOf(settings), failed };
}
