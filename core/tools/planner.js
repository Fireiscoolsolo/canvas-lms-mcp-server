// Planner: your own Canvas to-do notes, checking items off, the calendar feed, deadline export, a daily briefing
// and study plans. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';
import { buildIcs, deadlineEvent } from '../ics.js';
import { planStudyBlocks } from '../study-plan.js';

const PLANNABLE = ['assignment', 'quiz', 'discussion_topic', 'wiki_page', 'planner_note', 'calendar_event', 'announcement', 'assessment_request', 'sub_assignment'];

export default function register(ctx) {
  const { tool, get, canvas, ok, fail, omitEmpty, friendly, localize, dayKey, daysFromNow, activeCourses, saveDownload, ID, LIMIT, BASE, TZ } = ctx;

  const P = 'planner';
  const absolute = (url) => (!url ? undefined : /^https?:\/\//i.test(url) ? url : `${BASE}${url}`);
  const me = () => canvas.get('/users/self', null, { ttl: 3600000 });
  const courseNames = async () => new Map((await activeCourses().catch(() => [])).map((c) => [String(c.id), c.name]));
  const dueOf = (i) => i.plannable?.due_at || i.plannable?.todo_date || i.plannable_date || null;

  function plannerRow(i, names) {
    const due = dueOf(i);
    return omitEmpty({
      type: i.plannable_type, plannable_id: i.plannable_id,
      title: i.plannable?.title || i.plannable?.name || '(untitled)',
      course: names.get(String(i.course_id)) || i.context_name, course_id: i.course_id,
      due_at: due, due_local: friendly(due),
      points: i.plannable?.points_possible,
      submitted: i.submissions?.submitted || undefined, graded: i.submissions?.graded || undefined,
      missing: i.submissions?.missing || undefined, late: i.submissions?.late || undefined,
      done: i.planner_override?.marked_complete || undefined, dismissed: i.planner_override?.dismissed || undefined,
      url: absolute(i.html_url),
    });
  }

  // Course contexts for calendar queries. Canvas accepts at most 10 context codes per request.
  async function contextCodes(courseIds) {
    const user = await me();
    const ids = courseIds?.length ? courseIds : (await activeCourses().catch(() => [])).map((c) => String(c.id));
    return [`user_${user.id}`, ...ids.slice(0, 9).map((id) => `course_${id}`)];
  }

  // ---- Seeing what is on your plate ----------------------------------------

  tool({
    name: 'list_planner_items', group: P,
    description: 'Your Canvas To Do list (the Planner) for a date range, across every course: assignments, quizzes, discussions, pages and your own notes, with plannable IDs for mark_planner_item_done.',
    schema: {
      start_date: z.string().optional().describe('Start of the range, YYYY-MM-DD. Default today.'),
      end_date: z.string().optional().describe('End of the range, YYYY-MM-DD. Default 14 days from now.'),
      incomplete_only: z.boolean().optional().describe('If true, leave out items you have already submitted or marked done.'),
      course_id: z.string().optional().describe('Only this course (numeric ID from list_courses).'),
      limit: LIMIT,
    },
    handler: async (a) => {
      const [items, names] = [
        await canvas.paginate('/planner/items', {
          start_date: a.start_date || dayKey(Date.now()), end_date: a.end_date || dayKey(daysFromNow(14)),
          filter: a.incomplete_only ? 'incomplete_items' : undefined,
          context_codes: a.course_id ? [`course_${a.course_id}`] : undefined,
        }, { max: a.limit || 200, ttl: 30000 }),
        await courseNames(),
      ];
      const rows = items.map((i) => plannerRow(i, names)).sort((x, y) => new Date(x.due_at || 0) - new Date(y.due_at || 0));
      return ok({ count: rows.length, timezone: TZ, items: rows });
    },
  });

  // ---- Your own to-do notes ------------------------------------------------

  get({
    name: 'list_planner_notes', group: P,
    description: 'Your own Canvas to-do notes (planner notes). Only you see these.',
    path: '/planner_notes',
    schema: {
      start_date: z.string().optional().describe('Only notes on or after this date, YYYY-MM-DD.'),
      end_date: z.string().optional().describe('Only notes on or before this date, YYYY-MM-DD.'),
      course_id: z.string().optional().describe('Only notes linked to this course.'),
    },
    params: (a) => ({ start_date: a.start_date, end_date: a.end_date, context_codes: a.course_id ? [`course_${a.course_id}`] : undefined }),
    paginate: true, max: 200,
    fields: ['id', 'title', 'details', 'todo_date', 'course_id', 'workflow_state', 'linked_object_type', 'linked_object_html_url'],
  });

  tool({
    name: 'create_planner_note', group: P, write: true,
    description: 'Add a to-do note to your Canvas planner, e.g. "Email Prof. Lee about the extension". It shows on your Canvas To Do list and calendar. Only you see it.',
    schema: {
      title: z.string().describe('What to do, e.g. "Start the lab report".'),
      todo_date: z.string().describe('When, as an ISO 8601 date or date-time, e.g. "2026-11-07" or "2026-11-07T18:00:00".'),
      details: z.string().optional().describe('Optional longer notes.'),
      course_id: z.string().optional().describe('Optional course to file it under (numeric ID from list_courses).'),
    },
    handler: async (a) => {
      const r = await canvas.post('/planner_notes', omitEmpty({ title: a.title, details: a.details, todo_date: a.todo_date, course_id: a.course_id }));
      return ok(omitEmpty({ id: r.id, title: r.title, todo_date: r.todo_date, todo_local: friendly(r.todo_date), course_id: r.course_id }), 'Added to your Canvas planner.');
    },
  });

  tool({
    name: 'update_planner_note', group: P, write: true, confirm: true,
    preview: async (a) => ({ action: 'CHANGE this planner note', ...a }),
    description: 'Change one of your Canvas planner notes: its title, details, date or course.',
    schema: {
      note_id: ID.describe('Planner note ID, from list_planner_notes or list_planner_items (plannable_id of a planner_note).'),
      title: z.string().optional().describe('New title.'),
      details: z.string().optional().describe('New details.'),
      todo_date: z.string().optional().describe('New date, ISO 8601.'),
      course_id: z.string().optional().describe('Course to file it under.'),
    },
    handler: async (a) => {
      const r = await canvas.put(`/planner_notes/${a.note_id}`, omitEmpty({ title: a.title, details: a.details, todo_date: a.todo_date, course_id: a.course_id }));
      return ok(omitEmpty({ id: r.id, title: r.title, todo_date: r.todo_date, todo_local: friendly(r.todo_date), course_id: r.course_id }), 'Updated.');
    },
  });

  tool({
    name: 'delete_planner_note', group: P, write: true, confirm: true,
    preview: async (a) => { const n = await canvas.get(`/planner_notes/${a.note_id}`); return { action: 'DELETE this planner note', title: n.title, todo_date: n.todo_date, updated_at: n.updated_at }; },
    description: 'Delete one of your Canvas planner notes. This only affects your own notes.',
    schema: { note_id: ID.describe('Planner note ID, from list_planner_notes.') },
    handler: async (a) => { await canvas.del(`/planner_notes/${a.note_id}`); return ok({ deleted: a.note_id }, 'Deleted.'); },
  });

  // ---- Checking things off -------------------------------------------------

  async function setOverride(a, fields) {
    const overrides = await canvas.paginate('/planner/overrides', null, { max: 2000, ttl: 0 });
    const existing = overrides.find((o) => o.plannable_type === a.plannable_type && String(o.plannable_id) === String(a.plannable_id));
    return existing
      ? canvas.put(`/planner/overrides/${existing.id}`, fields)
      : canvas.post('/planner/overrides', { plannable_type: a.plannable_type, plannable_id: a.plannable_id, ...fields });
  }
  const itemSchema = {
    plannable_type: z.enum(PLANNABLE).describe('The item type, from list_planner_items: assignment, quiz, discussion_topic, wiki_page, planner_note, calendar_event, announcement, assessment_request or sub_assignment.'),
    plannable_id: ID.describe('The item\'s plannable_id from list_planner_items.'),
  };

  tool({
    name: 'mark_planner_item_done', group: P, write: true,
    description: 'Check an item off (or back on) your Canvas To Do list. This only changes your own list; it does not submit anything.',
    schema: { ...itemSchema, done: z.boolean().optional().describe('true (default) to mark it done, false to mark it not done again.') },
    handler: async (a) => {
      const r = await setOverride(a, { marked_complete: a.done !== false });
      return ok({ plannable_type: a.plannable_type, plannable_id: a.plannable_id, marked_complete: r?.marked_complete ?? a.done !== false }, a.done === false ? 'Marked not done.' : 'Marked done.');
    },
  });

  tool({
    name: 'dismiss_planner_item', group: P, write: true,
    description: 'Hide an item from your Canvas To Do list and its "new activity" badge, without marking it done. This only changes your own list.',
    schema: itemSchema,
    handler: async (a) => {
      await setOverride(a, { dismissed: true });
      return ok({ plannable_type: a.plannable_type, plannable_id: a.plannable_id, dismissed: true }, 'Dismissed from your To Do list.');
    },
  });

  // ---- Getting deadlines into other calendars --------------------------------

  tool({
    name: 'get_calendar_feed_url', group: P,
    description: 'Your personal Canvas calendar feed link and how to subscribe to it in Google Calendar, Apple Calendar or Outlook, so Canvas deadlines show up there and stay updated.',
    handler: async () => {
      const profile = await canvas.get('/users/self/profile', null, { ttl: 3600000 });
      const feed = profile?.calendar?.ics;
      if (!feed) return fail('Canvas did not return a calendar feed link for your account. Your school may have turned the feed off.');
      return ok({
        feed_url: feed,
        keep_private: 'Anyone with this link can see your Canvas calendar, so do not share it.',
        how_to_subscribe: {
          google_calendar: 'calendar.google.com > Other calendars (+) > From URL > paste the link > Add calendar. Google refreshes it every few hours.',
          apple_calendar: 'Calendar app > File > New Calendar Subscription > paste the link. On iPhone: Settings > Calendar > Accounts > Add Account > Other > Add Subscribed Calendar.',
          outlook: 'outlook.com calendar > Add calendar > Subscribe from web > paste the link.',
        },
        one_time_file: 'For a one-time file instead of a live feed, use export_deadlines_ics.',
      });
    },
  });

  tool({
    name: 'export_deadlines_ics', group: P, local: true,
    description: 'Save your upcoming Canvas deadlines as an .ics calendar file you can import into Google Calendar, Apple Calendar or Outlook, with a reminder before each one. Nothing changes in Canvas.',
    schema: {
      days: z.number().int().positive().max(365).optional().describe('How many days ahead to include. Default 60.'),
      include_completed: z.boolean().optional().describe('If true, also include work you have already submitted.'),
      include_events: z.boolean().optional().describe('If true, also include calendar events such as class meetings, not just deadlines.'),
      remind_minutes_before: z.number().int().min(0).max(20160).optional().describe('Reminder this many minutes before each deadline. Default 1440 (one day). 0 for no reminder.'),
    },
    handler: async (a) => {
      const days = a.days || 60;
      const [items, names] = [
        await canvas.paginate('/planner/items', { start_date: dayKey(Date.now()), end_date: dayKey(daysFromNow(days)), filter: a.include_completed ? undefined : 'incomplete_items' }, { max: 1000, ttl: 0 }),
        await courseNames(),
      ];
      const host = BASE ? new URL(BASE).hostname : 'canvas';
      const events = items.filter((i) => dueOf(i) && i.plannable_type !== 'calendar_event').map((i) => deadlineEvent({
        id: i.plannable_id, type: i.plannable_type, title: i.plannable?.title || i.plannable?.name || 'Canvas item',
        course: names.get(String(i.course_id)) || i.context_name, due: dueOf(i), url: absolute(i.html_url), points: i.plannable?.points_possible,
      }, host));
      if (a.include_events) {
        const cal = await canvas.paginate('/calendar_events', { type: 'event', start_date: dayKey(Date.now()), end_date: dayKey(daysFromNow(days)), context_codes: await contextCodes() }, { max: 500, ttl: 0 }).catch(() => []);
        for (const e of cal) events.push({ uid: `event-${e.id}@${host}`, title: e.title, start: e.start_at, end: e.end_at, location: e.location_name, url: e.html_url, description: e.context_name });
      }
      if (!events.length) return ok({ events: 0, note: `Nothing with a date in the next ${days} days.` });
      const text = buildIcs(events, { name: 'Canvas deadlines', remindMinutes: a.remind_minutes_before ?? 1440 });
      const saved = await saveDownload({ text, name: 'canvas-deadlines.ics', contentType: 'text/calendar' });
      return ok({
        saved_to: saved.saved_to, events: events.length, days_ahead: days,
        how_to_import: 'Google Calendar: Settings > Import & export > Import. Apple Calendar: File > Import. Outlook: Add calendar > Upload from file. Importing again later adds the new deadlines without duplicating old ones.',
        live_feed_instead: 'For a calendar that updates itself, use get_calendar_feed_url.',
      }, `Saved ${events.length} items to an .ics file.`, { links: [saved.link] });
    },
  });

  // ---- Daily briefing --------------------------------------------------------

  const Item = z.object({
    title: z.string(), course: z.string().optional(), type: z.string().optional(),
    due_at: z.string().optional(), due_local: z.string().optional(), points: z.number().optional(), url: z.string().optional(),
  });
  tool({
    name: 'daily_briefing', group: P,
    description: 'Today at a glance: today\'s classes and events, what is due today and tomorrow, missing work, grades posted in the last day, unread announcements and your unread inbox count, in one call.',
    output: {
      date: z.string(), timezone: z.string(),
      events_today: z.array(z.object({ title: z.string(), start_local: z.string().optional(), end_local: z.string().optional(), location: z.string().optional(), course: z.string().optional() })),
      due_today: z.array(Item), due_tomorrow: z.array(Item),
      missing_count: z.number(), missing: z.array(Item),
      new_grades: z.array(z.object({ assignment: z.string(), course: z.string().optional(), score: z.number().optional(), grade: z.string().optional(), points_possible: z.number().optional() })),
      unread_announcements: z.array(z.object({ title: z.string(), course: z.string().optional(), posted_local: z.string().optional() })),
      unread_inbox: z.number().nullable(),
    },
    handler: async () => {
      const now = Date.now();
      const today = dayKey(now);
      const tomorrow = dayKey(now + 86400000);
      const names = await courseNames();
      const codes = await contextCodes().catch(() => []);
      const [planner, events, missing, stream, unread] = [
        await canvas.paginate('/planner/items', { start_date: today, end_date: tomorrow, filter: 'incomplete_items' }, { max: 200, ttl: 30000 }).catch(() => []),
        await canvas.paginate('/calendar_events', { type: 'event', start_date: today, end_date: today, context_codes: codes }, { max: 100, ttl: 60000 }).catch(() => []),
        await canvas.paginate('/users/self/missing_submissions', { include: ['course'], filter: ['submittable'] }, { max: 100, ttl: 60000 }).catch(() => []),
        await canvas.paginate('/users/self/activity_stream', { only_active_courses: true }, { max: 100, ttl: 30000 }).catch(() => []),
        await canvas.get('/conversations/unread_count', null, { ttl: 30000 }).catch(() => null),
      ];
      const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
      const item = (i) => omitEmpty({ title: String(i.plannable?.title || i.plannable?.name || '(untitled)'), course: names.get(String(i.course_id)) || i.context_name, type: i.plannable_type, due_at: dueOf(i), due_local: friendly(dueOf(i)), points: num(i.plannable?.points_possible), url: absolute(i.html_url) });
      const dueRows = planner.filter((i) => dueOf(i)).sort((x, y) => new Date(dueOf(x)) - new Date(dueOf(y)));
      const dayAgo = now - 86400000;
      const weekAgo = now - 7 * 86400000;
      const data = {
        date: new Date(now).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), timezone: TZ,
        events_today: events.map((e) => omitEmpty({ title: String(e.title || '(untitled)'), start_local: e.all_day ? 'all day' : localize(e.start_at), end_local: e.all_day ? undefined : localize(e.end_at), location: e.location_name, course: e.context_name })),
        due_today: dueRows.filter((i) => dayKey(dueOf(i)) === today).map(item),
        due_tomorrow: dueRows.filter((i) => dayKey(dueOf(i)) === tomorrow).map(item),
        missing_count: missing.length,
        missing: missing.slice(0, 8).map((m) => omitEmpty({ title: String(m.name || '(untitled)'), course: m.course?.name, due_at: m.due_at, due_local: friendly(m.due_at), points: num(m.points_possible), url: m.html_url })),
        new_grades: stream.filter((s) => s.type === 'Submission' && (s.score != null || s.grade) && new Date(s.updated_at || s.created_at).getTime() > dayAgo)
          .map((s) => omitEmpty({ assignment: String(s.assignment?.name || s.title || 'An assignment'), course: names.get(String(s.course_id)), score: num(s.score), grade: s.grade != null ? String(s.grade) : undefined, points_possible: num(s.assignment?.points_possible) })),
        unread_announcements: stream.filter((s) => s.type === 'Announcement' && s.read_state === false && new Date(s.created_at).getTime() > weekAgo)
          .map((s) => omitEmpty({ title: String(s.title || '(untitled)'), course: names.get(String(s.course_id)), posted_local: friendly(s.created_at) })),
        unread_inbox: num(unread?.unread_count) ?? null,
      };
      return ok(data, null, { structured: data });
    },
  });

  // ---- Study plans -----------------------------------------------------------

  tool({
    name: 'study_plan', group: P,
    description: 'Propose study blocks for everything due in the next N days: estimates the hours each item needs, then spreads them over the days before each deadline inside your study hours, around your Canvas calendar. Read-only; use schedule_study_plan to put the blocks on your calendar.',
    schema: {
      days: z.number().int().positive().max(60).optional().describe('How many days ahead to plan. Default 14.'),
      day_start: z.string().optional().describe('Earliest study time each day, 24-hour "HH:MM". Default "16:00".'),
      day_end: z.string().optional().describe('Latest study time each day, 24-hour "HH:MM". Default "21:00".'),
      max_hours_per_day: z.number().positive().max(12).optional().describe('Most study hours per day. Default 3.'),
      block_minutes: z.number().int().min(15).max(240).optional().describe('Length of each study block in minutes. Default 60.'),
      skip_weekends: z.boolean().optional().describe('If true, plan nothing on Saturdays and Sundays.'),
      course_id: z.string().optional().describe('Only plan for this course.'),
    },
    handler: async (a) => {
      const days = a.days || 14;
      const names = await courseNames();
      const items = await canvas.paginate('/planner/items', {
        start_date: dayKey(Date.now()), end_date: dayKey(daysFromNow(days)), filter: 'incomplete_items',
        context_codes: a.course_id ? [`course_${a.course_id}`] : undefined,
      }, { max: 300, ttl: 30000 });
      const busy = await canvas.paginate('/calendar_events', { type: 'event', start_date: dayKey(Date.now()), end_date: dayKey(daysFromNow(days)), context_codes: await contextCodes() }, { max: 500, ttl: 60000 })
        .then((evs) => evs.filter((e) => !e.all_day).map((e) => ({ start: e.start_at, end: e.end_at })))
        .catch(() => []);
      const work = items.filter((i) => dueOf(i)).map((i) => ({
        title: i.plannable?.title || i.plannable?.name || 'Canvas item', type: i.plannable_type, points: i.plannable?.points_possible,
        due_at: dueOf(i), course: names.get(String(i.course_id)) || i.context_name, course_id: i.course_id ? String(i.course_id) : undefined,
      }));
      const plan = planStudyBlocks(work, { dayStart: a.day_start, dayEnd: a.day_end, maxHoursPerDay: a.max_hours_per_day, blockMinutes: a.block_minutes, skipWeekends: a.skip_weekends, busy });
      const short = plan.items.filter((i) => i.unscheduled_hours > 0);
      return ok(omitEmpty({
        window_days: days, timezone: TZ,
        total_study_hours: Number(plan.blocks.reduce((t, b) => t + (new Date(b.end) - new Date(b.start)) / 3600000, 0).toFixed(1)),
        blocks: plan.blocks.map((b) => omitEmpty({ title: b.title, when: friendly(b.start), start: b.start, end: b.end, course: b.course, course_id: b.course_id, due: friendly(b.due_at) })),
        per_item: plan.items,
        could_not_fit: short.length ? short.map((i) => `${i.title}: ${i.unscheduled_hours}h more than fits before it is due. Start earlier, raise max_hours_per_day or widen the study hours.`) : undefined,
        how_estimates_work: 'Exams 6h, projects and papers 4-10h, quizzes 1.5h, discussions 1h, other work 1-5h by points. These are rough; adjust them with the user.',
        next_step: 'To put these on the Canvas calendar (or as planner notes), call schedule_study_plan with the blocks the user wants.',
      }));
    },
  });

  const scheduleBlocks = async (a) => {
    const user = await me();
    const created = [];
    const failed = [];
    for (const b of a.blocks.slice(0, 60)) {
      try {
        if (a.add_to === 'planner') {
          const r = await canvas.post('/planner_notes', omitEmpty({ title: b.title, todo_date: b.start, details: `Study block until ${localize(b.end)}.`, course_id: b.course_id }));
          created.push({ id: r.id, title: r.title, when: friendly(b.start) });
        } else {
          const r = await canvas.post('/calendar_events', { calendar_event: { context_code: `user_${user.id}`, title: b.title, start_at: b.start, end_at: b.end, description: 'Study block planned with your AI assistant.' } });
          created.push({ id: r.id, title: r.title, when: friendly(b.start) });
        }
      } catch (e) { failed.push({ title: b.title, error: e.message }); }
    }
    return ok(omitEmpty({ added_to: a.add_to === 'planner' ? 'Canvas planner notes' : 'your Canvas calendar', created: created.length, items: created, failed }), `Added ${created.length} study block${created.length === 1 ? '' : 's'}.`);
  };
  scheduleBlocks.preview = async (a) => ({
    action: `Add ${Math.min(a.blocks.length, 60)} study blocks to ${a.add_to === 'planner' ? 'your Canvas planner' : 'your Canvas calendar'}`,
    blocks: a.blocks.slice(0, 60).map((b) => `${b.title}, ${friendly(b.start)}`),
    visible_to: 'only you',
  });
  tool({
    name: 'schedule_study_plan', group: P, write: true, confirm: true,
    description: 'Put study blocks (from study_plan) on your personal Canvas calendar, or add them as planner notes. Only you see them. At most 60 blocks per call.',
    schema: {
      blocks: z.array(z.object({
        title: z.string().describe('Block title, e.g. "Study: Lab report".'),
        start: z.string().describe('Start, ISO 8601.'),
        end: z.string().describe('End, ISO 8601.'),
        course_id: z.string().optional().describe('Optional course ID.'),
      })).min(1).describe('The blocks to add, usually copied from study_plan.'),
      add_to: z.enum(['calendar', 'planner']).optional().describe('"calendar" (default) for timed calendar events, or "planner" for to-do notes.'),
    },
    handler: scheduleBlocks,
  });
}
