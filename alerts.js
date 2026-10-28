// Phone alerts for the Remote Edition: new grades, new announcements, work due soon and a Canvas token that is
// about to expire. Sent through ntfy (a free phone app) and/or a Discord webhook. Only the computer that is
// serving runs index.js, so a group of computers never sends the same alert twice.
import fs from 'node:fs';
import path from 'node:path';

// Where the "already told you about this" state lives in your Canvas custom-data store, so every computer shares it.
const NAMESPACE = 'io.github.fireiscoolsolo.canvas-mcp';
const STATE_SCOPE = '/users/self/custom_data/alerts';
const ALL_TYPES = ['grades', 'announcements', 'due', 'token'];
const TAGS = { grades: 'mortar_board', announcements: 'loudspeaker', due: 'alarm_clock', token: 'key', test: 'white_check_mark' };
const DAY = 86400000;
const GRADE_SUMMARY_AFTER = 3;

export function alertSettings(env = process.env) {
  const types = String(env.CANVAS_ALERTS || ALL_TYPES.join(','))
    .split(',').map((s) => s.trim().toLowerCase()).filter((t) => ALL_TYPES.includes(t));
  return {
    ntfyTopic: String(env.CANVAS_ALERTS_NTFY_TOPIC || '').trim(),
    ntfyServer: String(env.CANVAS_ALERTS_NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, ''),
    discordWebhook: String(env.CANVAS_ALERTS_DISCORD_WEBHOOK || '').trim(),
    types: new Set(types),
    intervalMinutes: Math.max(5, Number(env.CANVAS_ALERTS_INTERVAL_MINUTES) || 15),
    dueHours: Math.max(1, Number(env.CANVAS_ALERTS_DUE_HOURS) || 24),
    tokenDays: 5,
  };
}

export const alertsEnabled = (s) => Boolean(s.ntfyTopic || s.discordWebhook) && s.types.size > 0;

const plain = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const when = (d) => d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Decide which alerts to send. Pure: takes what Canvas returned plus the saved state and returns the alerts and
 * the next state. The very first run only records a starting point, so nothing old is announced.
 */
export function collectAlerts({ stream = [], planner = [], tokens = [], courseNames = {}, state = {}, now = new Date(), settings, baseUrl = '' }) {
  const alerts = [];
  const next = { last_check: now.toISOString(), due_alerted: { ...(state.due_alerted || {}) }, token_alerted_on: state.token_alerted_on || null };
  const since = state.last_check ? new Date(state.last_check) : null;
  const course = (id) => courseNames[String(id)] || 'one of your courses';
  const absolute = (url) => (!url ? undefined : /^https?:\/\//.test(url) ? url : `${baseUrl}${url}`);

  if (since) {
    const grades = [];
    for (const s of stream) {
      const at = new Date(s.updated_at || s.created_at);
      if (!(at > since)) continue;
      if (s.type === 'Submission' && settings.types.has('grades') && (s.score != null || s.grade)) {
        const pts = s.assignment?.points_possible;
        const shown = s.score != null ? `${s.score}${pts ? `/${pts}` : ''}` : s.grade;
        const letter = s.grade && s.score != null && String(s.grade) !== String(s.score) ? ` (${s.grade})` : '';
        grades.push({ type: 'grades', title: `New grade in ${course(s.course_id)}`, message: `${s.assignment?.name || s.title || 'An assignment'}: ${shown}${letter}`, url: absolute(s.html_url) });
      } else if (s.type === 'Announcement' && settings.types.has('announcements')) {
        const body = plain(s.message);
        alerts.push({ type: 'announcements', title: `Announcement in ${course(s.course_id)}`, message: clip(`${s.title}${body ? `: ${body}` : ''}`, 300), url: absolute(s.html_url) });
      }
    }
    // Lots of grades at once (end of term) become one summary instead of a burst of notifications.
    if (grades.length > GRADE_SUMMARY_AFTER) {
      alerts.unshift({ type: 'grades', title: `${grades.length} new grades posted`, message: clip(grades.map((g) => `${g.title.replace('New grade in ', '')}: ${g.message}`).join('\n'), 900), url: `${baseUrl}/grades` });
    } else {
      alerts.unshift(...grades);
    }
  }

  if (settings.types.has('due')) {
    const horizon = now.getTime() + settings.dueHours * 3600000;
    for (const i of planner) {
      const due = i.plannable?.due_at || i.plannable_date;
      if (!due) continue;
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

/** Send one alert to every configured channel. Throws if none of them accepted it. */
export async function deliver(alert, settings, fetchImpl = fetch) {
  const sends = [];
  if (settings.ntfyTopic) {
    sends.push(['ntfy', fetchImpl(`${settings.ntfyServer}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: settings.ntfyTopic, title: alert.title, message: alert.message, click: alert.url,
        tags: [TAGS[alert.type] || 'bell'], priority: alert.type === 'due' || alert.type === 'token' ? 4 : 3,
      }),
    })]);
  }
  if (settings.discordWebhook) {
    sends.push(['Discord', fetchImpl(settings.discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: clip(`**${alert.title}**\n${alert.message}${alert.url ? `\n<${alert.url}>` : ''}`, 1900), allowed_mentions: { parse: [] } }),
    })]);
  }
  const results = await Promise.allSettled(sends.map(([, p]) => p));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? `${sends[i][0]}: ${r.reason.message}` : r.value.ok ? null : `${sends[i][0]}: HTTP ${r.value.status}`))
    .filter(Boolean);
  if (failed.length === sends.length) throw new Error(`Alert not delivered (${failed.join('; ')})`);
  return failed;
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

export async function gatherAlertData(canvas, settings, now) {
  const want = (t) => settings.types.has(t);
  const stream = want('grades') || want('announcements')
    ? await canvas.paginate('/users/self/activity_stream', { only_active_courses: true }, { max: 100, ttl: 0 }).catch(() => [])
    : [];
  const planner = want('due')
    ? await canvas.paginate('/planner/items', { start_date: now.toISOString(), end_date: new Date(now.getTime() + settings.dueHours * 3600000).toISOString(), filter: 'incomplete_items' }, { max: 100, ttl: 0 }).catch(() => [])
    : [];
  let tokens = [];
  if (want('token')) {
    const me = await canvas.get('/users/self', null, { ttl: 3600000 }).catch(() => null);
    if (me) tokens = await canvas.paginate(`/users/${me.id}/user_generated_tokens`, {}, { max: 100, ttl: 0 }).catch(() => []);
  }
  const courses = await canvas.paginate('/courses', { enrollment_state: 'active' }, { max: 60, ttl: 600000 }).catch(() => []);
  return { stream, planner, tokens, courseNames: Object.fromEntries(courses.map((c) => [String(c.id), c.name])) };
}

/** Start checking every few minutes. Returns null when no alert channel is set up. */
export function startAlerts({ canvas, log, baseUrl, env = process.env, stateFile = path.resolve('alerts-state.json'), fetchImpl = fetch }) {
  const settings = alertSettings(env);
  if (!alertsEnabled(settings)) {
    log('phone alerts off (set CANVAS_ALERTS_NTFY_TOPIC or CANVAS_ALERTS_DISCORD_WEBHOOK in .env to turn them on)');
    return null;
  }
  const store = stateStore(canvas, stateFile);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const state = await store.load();
      const { alerts, state: next } = collectAlerts({ ...(await gatherAlertData(canvas, settings, now)), state, now, settings, baseUrl });
      let sent = 0;
      for (const a of alerts) {
        try { await deliver(a, settings, fetchImpl); sent++; } catch (e) { log(e.message); }
      }
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
  const via = [settings.ntfyTopic && 'ntfy', settings.discordWebhook && 'Discord'].filter(Boolean).join(' and ');
  log(`phone alerts on: ${[...settings.types].join(', ')} every ${settings.intervalMinutes} min via ${via}`);
  return { tick, stop: () => clearInterval(timer) };
}

/** `canvas-lms-mcp-remote test-alert`: send one test alert using the settings in .env. */
export async function sendTestAlert(env = process.env, fetchImpl = fetch) {
  const settings = alertSettings(env);
  if (!alertsEnabled(settings)) throw new Error('No alert channel is set. Add CANVAS_ALERTS_NTFY_TOPIC or CANVAS_ALERTS_DISCORD_WEBHOOK to your .env.');
  const failed = await deliver({ type: 'test', title: 'Canvas alerts are working', message: 'You will get alerts here for new grades, announcements, work due soon and an expiring Canvas token.' }, settings, fetchImpl);
  return { channels: [settings.ntfyTopic && 'ntfy', settings.discordWebhook && 'Discord'].filter(Boolean), failed };
}
