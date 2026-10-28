import test from 'node:test';
import assert from 'node:assert/strict';
import { alertSettings, alertsEnabled, collectAlerts, deliver, sendTestAlert } from '../alerts.js';

const now = new Date('2026-10-28T12:00:00Z');
const settings = alertSettings({ CANVAS_ALERTS_NTFY_TOPIC: 'canvas-test-topic' });
const courseNames = { 1: 'Biology', 2: 'Calculus I' };
const later = (h) => new Date(now.getTime() + h * 3600000).toISOString();
const earlier = (h) => new Date(now.getTime() - h * 3600000).toISOString();

test('alertSettings reads .env values, with sensible defaults', () => {
  assert.equal(alertsEnabled(alertSettings({})), false, 'off until a channel is set');
  assert.equal(alertsEnabled(settings), true);
  assert.deepEqual([...settings.types], ['grades', 'announcements', 'due', 'token']);
  assert.equal(settings.intervalMinutes, 15);
  assert.equal(settings.dueHours, 24);
  assert.equal(settings.ntfyServer, 'https://ntfy.sh');
  const custom = alertSettings({ CANVAS_ALERTS_DISCORD_WEBHOOK: 'https://discord.example/hook', CANVAS_ALERTS: 'grades, due, nonsense', CANVAS_ALERTS_INTERVAL_MINUTES: '1', CANVAS_ALERTS_NTFY_SERVER: 'https://ntfy.example.com/' });
  assert.deepEqual([...custom.types], ['grades', 'due']);
  assert.equal(custom.intervalMinutes, 5, 'never more often than every 5 minutes');
  assert.equal(custom.ntfyServer, 'https://ntfy.example.com');
});

test('the first run only records a starting point', () => {
  const stream = [{ type: 'Submission', course_id: 1, updated_at: earlier(1), score: 9, assignment: { name: 'Lab 1', points_possible: 10 } }];
  const r = collectAlerts({ stream, courseNames, now, settings, state: {} });
  assert.deepEqual(r.alerts, []);
  assert.equal(r.state.last_check, now.toISOString());
});

test('new grades and announcements since the last check', () => {
  const stream = [
    { type: 'Submission', course_id: 1, updated_at: earlier(1), score: 9, grade: 'A-', assignment: { name: 'Lab 1', points_possible: 10 }, html_url: '/courses/1/assignments/5' },
    { type: 'Submission', course_id: 2, updated_at: earlier(30), score: 5, assignment: { name: 'Old quiz' } },
    { type: 'Submission', course_id: 2, updated_at: earlier(1), score: null, grade: null, assignment: { name: 'Ungraded' } },
    { type: 'Announcement', course_id: 2, updated_at: earlier(2), title: 'Exam moved', message: '<p>The exam is now on <b>Friday</b>.</p>', html_url: 'https://s.instructure.com/courses/2/discussion_topics/9' },
  ];
  const r = collectAlerts({ stream, courseNames, now, settings, state: { last_check: earlier(24) }, baseUrl: 'https://s.instructure.com' });
  assert.deepEqual(r.alerts, [
    { type: 'grades', title: 'New grade in Biology', message: 'Lab 1: 9/10 (A-)', url: 'https://s.instructure.com/courses/1/assignments/5' },
    { type: 'announcements', title: 'Announcement in Calculus I', message: 'Exam moved: The exam is now on Friday .', url: 'https://s.instructure.com/courses/2/discussion_topics/9' },
  ]);
});

test('many grades at once become one summary', () => {
  const stream = [1, 2, 3, 4, 5].map((n) => ({ type: 'Submission', course_id: 1, updated_at: earlier(1), score: n, assignment: { name: `HW ${n}`, points_possible: 5 } }));
  const r = collectAlerts({ stream, courseNames, now, settings, state: { last_check: earlier(2) }, baseUrl: 'https://s.instructure.com' });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].title, '5 new grades posted');
  assert.match(r.alerts[0].message, /Biology: HW 1: 1\/5\nBiology: HW 2/);
});

test('work due soon is announced once, and skipped once submitted', () => {
  const planner = [
    { plannable_id: 11, plannable: { title: 'Essay', due_at: later(5) }, context_name: 'English', html_url: '/courses/3/assignments/11', submissions: { submitted: false } },
    { plannable_id: 12, plannable: { title: 'Done already', due_at: later(3) }, submissions: { submitted: true } },
    { plannable_id: 13, plannable: { title: 'Next week', due_at: later(100) } },
    { plannable_id: 14, plannable: { title: 'Ticked off', due_at: later(2) }, planner_override: { marked_complete: true } },
  ];
  const first = collectAlerts({ planner, courseNames, now, settings, state: { last_check: earlier(1) }, baseUrl: 'https://s.instructure.com' });
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].title, 'Due in 5 hours: Essay');
  assert.match(first.alerts[0].message, /^English, due .*Not submitted yet\.$/);
  assert.equal(first.alerts[0].url, 'https://s.instructure.com/courses/3/assignments/11');
  const second = collectAlerts({ planner, courseNames, now, settings, state: first.state });
  assert.deepEqual(second.alerts, [], 'not repeated on the next check');
  const moved = [{ ...planner[0], plannable: { title: 'Essay', due_at: later(6) } }];
  assert.equal(collectAlerts({ planner: moved, courseNames, now, settings, state: first.state }).alerts.length, 1, 'announced again if the due date changes');
  const old = collectAlerts({ planner: [], now: new Date(now.getTime() + 9 * 86400000), settings, state: first.state });
  assert.deepEqual(old.state.due_alerted, {}, 'forgets assignments due over a week ago');
});

test('an expiring token is announced once a day', () => {
  const tokens = [
    { expires_at: new Date(now.getTime() + 3 * 86400000).toISOString(), workflow_state: 'active' },
    { expires_at: new Date(now.getTime() + 40 * 86400000).toISOString() },
    { expires_at: null },
  ];
  const r = collectAlerts({ tokens, now, settings, state: { last_check: earlier(1) }, baseUrl: 'https://s.instructure.com' });
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].message, /expires in 3 days/);
  assert.equal(r.alerts[0].url, 'https://s.instructure.com/profile/settings');
  assert.equal(collectAlerts({ tokens, now, settings, state: r.state }).alerts.length, 0, 'once per day');
});

test('disabled alert types are skipped', () => {
  const only = alertSettings({ CANVAS_ALERTS_NTFY_TOPIC: 't', CANVAS_ALERTS: 'token' });
  const stream = [{ type: 'Submission', course_id: 1, updated_at: earlier(1), score: 1, assignment: { name: 'x' } }];
  const planner = [{ plannable_id: 1, plannable: { title: 'x', due_at: later(1) } }];
  assert.deepEqual(collectAlerts({ stream, planner, now, settings: only, state: { last_check: earlier(2) } }).alerts, []);
});

test('deliver sends to ntfy and Discord and reports failures', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: !url.includes('discord'), status: 500 }; };
  const both = alertSettings({ CANVAS_ALERTS_NTFY_TOPIC: 'my-topic', CANVAS_ALERTS_DISCORD_WEBHOOK: 'https://discord.example/hook' });
  const failed = await deliver({ type: 'due', title: 'Due in 2 hours: Essay', message: 'English', url: 'https://x/1' }, both, fetchImpl);
  assert.deepEqual(calls[0], { url: 'https://ntfy.sh/', body: { topic: 'my-topic', title: 'Due in 2 hours: Essay', message: 'English', click: 'https://x/1', tags: ['alarm_clock'], priority: 4 } });
  assert.deepEqual(calls[1].body, { content: '**Due in 2 hours: Essay**\nEnglish\n<https://x/1>', allowed_mentions: { parse: [] } });
  assert.deepEqual(failed, ['Discord: HTTP 500']);
  await assert.rejects(deliver({ type: 'grades', title: 't', message: 'm' }, alertSettings({ CANVAS_ALERTS_NTFY_TOPIC: 't' }), async () => { throw new Error('offline'); }), /Alert not delivered \(ntfy: offline\)/);
});

test('sendTestAlert needs a channel', async () => {
  await assert.rejects(sendTestAlert({}), /No alert channel is set/);
  const sent = await sendTestAlert({ CANVAS_ALERTS_NTFY_TOPIC: 't' }, async () => ({ ok: true }));
  assert.deepEqual(sent, { channels: ['ntfy'], failed: [] });
});
