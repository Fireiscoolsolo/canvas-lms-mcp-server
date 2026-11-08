// Synthetic planning tools: no single Canvas endpoint, they merge several. Registered by core/index.js.
import path from 'node:path';
import { z } from 'zod';

export default function register(ctx) {
  const { folderLink, tool, canvas, ok, omitEmpty, fence, fenceProse, html2text, localize, relativeDue, iso, daysFromNow, sleep, COURSE, TOKEN, TZ, DOWNLOAD_DIR, activeCourses, state, BASE, saveDownload, downloadFolder, fail, friendly } = ctx;

  const N = 'planning';

  tool({
    name: 'get_week_ahead', group: N,
    description: 'One-call view of the coming week: everything due, anything already missing, unread announcements, and unread inbox count. Merges the Planner feed, missing submissions, calendar and inbox.',
    schema: { days: z.number().int().positive().optional().describe('Default 7') },
    handler: async (a) => {
      const days = a.days || 7;
      const [planner, missing, unread] = [
        await canvas.paginate('/planner/items', { start_date: iso(new Date()), end_date: iso(daysFromNow(days)), filter: 'incomplete_items' }, { max: 200, ttl: 30000 }).catch(() => []),
        await canvas.paginate('/users/self/missing_submissions', { include: ['course'], filter: ['submittable'] }, { max: 50 }).catch(() => []),
        await canvas.get('/conversations/unread_count', null, { ttl: 30000 }).catch(() => null),
      ];
      const courses = await activeCourses();
      const cname = new Map(courses.map((c) => [String(c.id), c.name]));
      const due = planner.map((i) => ({
        type: i.plannable_type, title: i.plannable?.title || i.plannable?.name,
        course: cname.get(String(i.course_id)) || i.context_name,
        due_at: i.plannable?.due_at || i.plannable?.todo_date,
        points: i.plannable?.points_possible,
        submitted: i.submissions?.submitted ?? null, graded: i.submissions?.graded ?? null,
        html_url: i.html_url,
      })).filter((x) => x.due_at).sort((x, y) => new Date(x.due_at) - new Date(y.due_at))
        .map((x) => ({ ...x, due_local: localize(x.due_at), due_in: relativeDue(x.due_at) }));
      const byDay = {};
      for (const d of due) { const k = new Date(d.due_at).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }); (byDay[k] ||= []).push(d.title); }
      return ok(omitEmpty({
        window_days: days, timezone: TZ,
        total_due: due.length,
        total_points_at_stake: due.reduce((s, x) => s + Number(x.points || 0), 0),
        by_day: byDay,
        due_items: due,
        already_missing: missing.map((m) => ({ name: m.name, course: m.course?.name, due_at: m.due_at, overdue_by: relativeDue(m.due_at), points: m.points_possible })),
        unread_inbox_messages: unread?.unread_count ?? null,
      }));
    },
  });

  tool({
    name: 'get_workload_forecast', group: N,
    description: 'Points at stake per week over the next N weeks, so you can see crunch weeks before they hit.',
    schema: { weeks: z.number().int().positive().optional().describe('Default 6') },
    handler: async (a) => {
      const weeks = a.weeks || 6;
      const items = await canvas.paginate('/planner/items', { start_date: iso(new Date()), end_date: iso(daysFromNow(weeks * 7)) }, { max: 400, ttl: 60000 });
      const buckets = new Map();
      for (const i of items) {
        const due = i.plannable?.due_at || i.plannable?.todo_date;
        if (!due) continue;
        const wk = Math.floor((new Date(due) - Date.now()) / (7 * 86400000));
        if (wk < 0 || wk >= weeks) continue;
        const b = buckets.get(wk) || { week_offset: wk, starting: iso(daysFromNow(wk * 7)).slice(0, 10), items: 0, points: 0, titles: [] };
        b.items++; b.points += Number(i.plannable?.points_possible || 0);
        b.titles.push(i.plannable?.title || i.plannable?.name);
        buckets.set(wk, b);
      }
      const rows = [...buckets.values()].sort((x, y) => x.week_offset - y.week_offset);
      const peak = rows.reduce((m, r) => (r.points > (m?.points || 0) ? r : m), null);
      return ok({ weeks, forecast: rows, heaviest_week: peak ? { starting: peak.starting, points: peak.points, items: peak.items } : null });
    },
  });

  tool({
    name: 'get_all_unread', group: N,
    description: 'Every unread thing in one call: inbox messages, discussion replies, announcements and activity stream items.',
    handler: async () => {
      const [summary, inbox, convos] = [
        await canvas.get('/users/self/activity_stream/summary', null, { ttl: 30000 }).catch(() => []),
        await canvas.get('/conversations/unread_count', null, { ttl: 30000 }).catch(() => null),
        await canvas.paginate('/conversations', { scope: 'unread' }, { max: 20, ttl: 30000 }).catch(() => []),
      ];
      const courses = await activeCourses(20);
      const unreadTopics = [];
      for (const c of courses) {
        try {
          const tops = await canvas.paginate(`/courses/${c.id}/discussion_topics`, null, { max: 40 });
          for (const t of tops) if (t.unread_count > 0) unreadTopics.push({ course: c.name, course_id: c.id, topic_id: t.id, title: t.title, unread: t.unread_count, last_reply_at: t.last_reply_at });
        } catch { /* */ }
      }
      return ok(omitEmpty({
        activity_stream_summary: fenceProse(summary, 'activity stream'),
        unread_inbox_count: inbox?.unread_count ?? null,
        unread_conversations: convos.map((c) => ({ id: c.id, subject: c.subject, from: c.participants?.map((p) => p.name), last_message_at: c.last_message_at, context: c.context_name })),
        unread_discussions: unreadTopics,
      }));
    },
  });

  tool({
    name: 'course_health_check', group: N,
    description: 'Complete status of one course: current grade, what is missing, what is ungraded, what is coming up, and unread discussions.',
    schema: { course_id: COURSE },
    handler: async (a) => {
      const course = await canvas.get(`/courses/${a.course_id}`, { include: ['total_scores', 'term'] });
      const subs = await canvas.paginate(`/courses/${a.course_id}/students/submissions`, { student_ids: ['self'], include: ['assignment'], per_page: 100 }, { max: 300 });
      const e = (course.enrollments || [])[0] || {};
      const now = Date.now();
      const missing = [], ungraded = [], upcoming = [], graded = [];
      for (const s of subs) {
        const asg = s.assignment; if (!asg) continue;
        const row = { assignment_id: asg.id, name: asg.name, points_possible: asg.points_possible, due_at: asg.due_at, due_in: relativeDue(asg.due_at), score: s.score, submission_id: s.id };
        if (s.workflow_state === 'graded' && s.score !== null) graded.push(row);
        else if (s.missing || (asg.due_at && new Date(asg.due_at) < now && !s.submitted_at)) missing.push(row);
        else if (s.submitted_at) ungraded.push(row);
        else if (asg.due_at && new Date(asg.due_at) >= now) upcoming.push(row);
      }
      let unreadDiscussions = 0;
      try { for (const t of await canvas.paginate(`/courses/${a.course_id}/discussion_topics`, null, { max: 50 })) unreadDiscussions += t.unread_count || 0; } catch { /* */ }
      return ok(omitEmpty({
        course: course.name, course_id: course.id, term: course.term?.name,
        current_grade: { score: e.computed_current_score, letter: e.computed_current_grade },
        final_projection: { score: e.computed_final_score, letter: e.computed_final_grade },
        counts: { graded: graded.length, missing: missing.length, submitted_awaiting_grade: ungraded.length, upcoming: upcoming.length },
        points_lost_to_missing: missing.reduce((s, m) => s + Number(m.points_possible || 0), 0),
        missing, submitted_awaiting_grade: ungraded,
        upcoming: upcoming.sort((x, y) => new Date(x.due_at) - new Date(y.due_at)).slice(0, 10),
        unread_discussion_replies: unreadDiscussions,
      }));
    },
  });

  tool({
    name: 'semester_snapshot', group: N,
    description: 'Everything, everywhere, in one call: every active course with its grade, missing work, upcoming deadlines and unread counts. Expensive but comprehensive. Use at the start of a session.',
    handler: async (_a, { progress }) => {
      progress(0, 4, 'Reading your courses');
      const courses = await activeCourses(30);
      progress(1, 4, 'Checking missing work');
      const missing = await canvas.paginate('/users/self/missing_submissions', { include: ['course'] }, { max: 100 }).catch(() => []);
      const missingByCourse = new Map();
      for (const m of missing) { const k = String(m.course_id); (missingByCourse.get(k) || missingByCourse.set(k, []).get(k)).push({ name: m.name, due_at: m.due_at, points: m.points_possible }); }
      progress(2, 4, 'Checking what is due');
      const planner = await canvas.paginate('/planner/items', { start_date: iso(new Date()), end_date: iso(daysFromNow(14)), filter: 'incomplete_items' }, { max: 200 }).catch(() => []);
      progress(3, 4, 'Checking your inbox');
      const upcomingByCourse = new Map();
      for (const p of planner) { const k = String(p.course_id); if (!upcomingByCourse.has(k)) upcomingByCourse.set(k, []); upcomingByCourse.get(k).push({ title: p.plannable?.title || p.plannable?.name, due_at: p.plannable?.due_at || p.plannable?.todo_date, points: p.plannable?.points_possible }); }
      const rows = courses.map((c) => {
        const e = (c.enrollments || []).find((x) => x.type === 'student') || (c.enrollments || [])[0] || {};
        return omitEmpty({
          course_id: c.id, course: c.name, code: c.course_code, term: c.term?.name,
          current_score: e.computed_current_score, current_grade: e.computed_current_grade,
          missing_count: (missingByCourse.get(String(c.id)) || []).length,
          missing: missingByCourse.get(String(c.id)) || [],
          upcoming_14d: (upcomingByCourse.get(String(c.id)) || []).sort((x, y) => new Date(x.due_at) - new Date(y.due_at)),
        });
      });
      const inbox = await canvas.get('/conversations/unread_count', null, { ttl: 30000 }).catch(() => null);
      return ok({ generated_at: localize(new Date()), timezone: TZ, active_courses: rows.length, unread_inbox: inbox?.unread_count ?? null, total_missing: missing.length, courses: rows });
    },
  });

  tool({
    name: 'diff_since_last_check', group: N,
    description: 'What changed since a given time, or since you last asked: new grades posted, new announcements, new discussion replies, new inbox messages. Remembers when you last checked, so "what\'s new?" works without a date.',
    schema: { since: z.string().optional().describe('ISO 8601 timestamp, e.g. 2026-09-01T00:00:00Z. Omit to use the last time this was checked (or 3 days ago the first time).') },
    handler: async (a) => {
      const key = `${BASE}|diff_since_last_check`;
      const remembered = state.get(key);
      const sinceIso = a.since || remembered || iso(daysFromNow(-3));
      const since = new Date(sinceIso);
      if (Number.isNaN(since.getTime())) return fail(`"${a.since}" is not a date. Use ISO 8601, e.g. 2026-09-01T00:00:00Z.`);
      const stream = await canvas.paginate('/users/self/activity_stream', { only_active_courses: true }, { max: 100, ttl: 0 }).catch(() => []);
      const fresh = stream.filter((s) => new Date(s.updated_at || s.created_at) > since);
      const grouped = {};
      for (const s of fresh) {
        const k = s.type || 'Other';
        (grouped[k] ||= []).push(omitEmpty({
          title: s.title, course_id: s.course_id, at: s.updated_at || s.created_at, at_local: localize(s.updated_at || s.created_at),
          url: s.html_url, message: s.message ? fence(html2text(s.message).slice(0, 400), `activity: ${k}`) : undefined,
          grade: s.grade, score: s.score,
        }));
      }
      state.set(key, new Date().toISOString());
      return ok({ since: sinceIso, since_local: localize(sinceIso), since_source: a.since ? 'given' : remembered ? 'last check' : 'first check: 3 days ago', changed_items: fresh.length, by_type: grouped });
    },
  });

  tool({
    name: 'syllabus_digest', group: N,
    description: 'Pull a course syllabus and extract anything that looks like a date, percentage weight, or policy sentence. Rough heuristic extraction over the syllabus text.',
    schema: { course_id: COURSE },
    handler: async (a) => {
      const c = await canvas.get(`/courses/${a.course_id}`, { include: ['syllabus_body'] });
      if (!c.syllabus_body) return ok({ course: c.name, note: 'No syllabus body. Check list_course_files for an uploaded PDF syllabus.' });
      const text = html2text(c.syllabus_body);
      const dates = [...new Set((text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/gi) || []))];
      const weights = [...new Set((text.match(/[^.\n]*\b\d{1,3}\s?%[^.\n]*/g) || []).map((s) => s.trim()))].slice(0, 25);
      const policies = (text.split(/(?<=[.!?])\s+/).filter((s) => /\b(late|attendance|academic integrity|plagiaris|makeup|make-up|extension|drop|absent|grading scale|office hours)\b/i.test(s)) || []).slice(0, 25);
      return ok({ course: c.name, dates_found: dates.slice(0, 40), weight_statements: weights, policy_sentences: policies.map((p) => fence(p.trim(), 'syllabus policy')), full_text_chars: text.length });
    },
  });

  tool({
    name: 'deadline_conflict_check', group: N,
    description: 'Find days in the next N days where multiple assignments are due, weighted by points, so you can spot pileups early.',
    schema: { days: z.number().int().positive().optional().describe('Default 30'), min_items: z.number().int().positive().optional().describe('Default 2') },
    handler: async (a) => {
      const items = await canvas.paginate('/planner/items', { start_date: iso(new Date()), end_date: iso(daysFromNow(a.days || 30)), filter: 'incomplete_items' }, { max: 300 });
      const byDay = new Map();
      for (const i of items) {
        const due = i.plannable?.due_at || i.plannable?.todo_date; if (!due) continue;
        const k = new Date(due).toLocaleDateString('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' });
        const b = byDay.get(k) || { date: k, items: [], total_points: 0 };
        b.items.push({ title: i.plannable?.title || i.plannable?.name, course_id: i.course_id, points: i.plannable?.points_possible, due_local: localize(due) });
        b.total_points += Number(i.plannable?.points_possible || 0);
        byDay.set(k, b);
      }
      const conflicts = [...byDay.values()].filter((b) => b.items.length >= (a.min_items || 2)).sort((x, y) => y.total_points - x.total_points);
      return ok({ window_days: a.days || 30, conflict_days: conflicts.length, conflicts });
    },
  });

  tool({
    name: 'study_priority_ranking', group: N,
    description: 'Rank everything upcoming across all courses by a priority score combining grade impact, urgency, and how weak your current standing in that course is. Opinionated, and the formula is shown so you can disagree with it.',
    schema: { days: z.number().int().positive().optional().describe('Default 14') },
    handler: async (a) => {
      const days = a.days || 14;
      const courses = await activeCourses(30);
      const gradeByCourse = new Map();
      for (const c of courses) { const e = (c.enrollments || [])[0] || {}; gradeByCourse.set(String(c.id), { name: c.name, score: e.computed_current_score ?? null }); }
      const items = await canvas.paginate('/planner/items', { start_date: iso(new Date()), end_date: iso(daysFromNow(days)), filter: 'incomplete_items' }, { max: 300 });
      const rows = [];
      for (const i of items) {
        const due = i.plannable?.due_at || i.plannable?.todo_date; if (!due) continue;
        const pts = Number(i.plannable?.points_possible || 0);
        const hoursLeft = Math.max(1, (new Date(due) - Date.now()) / 3600000);
        const cg = gradeByCourse.get(String(i.course_id)) || {};
        const weakness = cg.score === null || cg.score === undefined ? 1 : Math.max(0, (85 - Number(cg.score)) / 85 + 0.2);
        const urgency = Math.min(3, 72 / hoursLeft);
        const score = (pts || 1) * urgency * weakness;
        rows.push({ title: i.plannable?.title || i.plannable?.name, type: i.plannable_type, course: cg.name, course_current_grade: cg.score ?? null, points: pts || null, due_at: due, due_local: localize(due), due_in: relativeDue(due), priority_score: Number(score.toFixed(1)), html_url: i.html_url });
      }
      rows.sort((x, y) => y.priority_score - x.priority_score);
      return ok({ window_days: days, formula: 'points * urgency(min(3, 72/hoursRemaining)) * weakness((85 - courseGrade)/85 + 0.2)', ranked: rows });
    },
  });

  tool({
    name: 'download_all_course_files', group: N, local: true,
    description: 'Bulk download every file you can access in a course to local disk. Can be a lot of requests and a lot of megabytes.',
    schema: { course_id: COURSE, dest_dir: z.string().optional(), max_files: z.number().int().positive().optional().describe('Default 50'), content_types: z.array(z.string()).optional() },
    handler: async (a, { progress }) => {
      const files = await canvas.paginate(`/courses/${a.course_id}/files`, { content_types: a.content_types }, { max: a.max_files || 50 });
      const course = await canvas.get(`/courses/${a.course_id}`);
      const dir = downloadFolder(a.dest_dir || path.join(DOWNLOAD_DIR, String(course.course_code || course.id).replace(/[^\w.-]/g, '_')));
      const saved = [], failed = [];
      for (const [i, f] of files.entries()) {
        progress(i, files.length, `Downloading ${f.display_name || f.filename}`);
        try {
          const r = await saveDownload({ url: f.url, dir, name: f.display_name || f.filename || `file-${f.id}`, contentType: f['content-type'] });
          saved.push({ file: path.basename(r.saved_to), bytes: r.bytes });
        } catch (e) { failed.push({ file: f.display_name, error: e.message }); }
      }
      progress(files.length, files.length, 'Done');
      return ok({ course: course.name, directory: dir, downloaded: saved.length, failed: failed.length, files: saved, failures: failed }, null, { links: saved.length ? [folderLink(dir, `${course.name} files`)] : [] });
    },
  });

  tool({
    name: 'export_course_archive', group: N, write: true, confirm: true,
    preview: async (a) => ({ action: 'Ask Canvas to package this course, then download the archive', course_id: a.course_id, save_in: downloadFolder(a.dest_dir) }),
    description: 'Trigger a full course export, poll until Canvas finishes packaging it, then download the .imscc archive locally. Use before a term ends and access disappears. Can take several minutes.',
    schema: { course_id: COURSE, dest_dir: z.string().optional(), timeout_seconds: z.number().int().positive().optional().describe('Default 300') },
    handler: async (a, { progress }) => {
      const dir = downloadFolder(a.dest_dir);
      const started = await canvas.post(`/courses/${a.course_id}/content_exports`, { export_type: 'common_cartridge', skip_notifications: true });
      const timeout = (a.timeout_seconds || 300) * 1000;
      const deadline = Date.now() + timeout;
      let exp = started;
      while (Date.now() < deadline) {
        await sleep(5000);
        exp = await canvas.get(`/courses/${a.course_id}/content_exports/${started.id}`, null, { ttl: 0 });
        progress(Math.min(95, exp.progress ?? Math.round((1 - (deadline - Date.now()) / timeout) * 90)), 100, `Canvas is packaging the course (${exp.workflow_state})`);
        if (exp.workflow_state === 'exported' || exp.workflow_state === 'failed') break;
      }
      if (exp.workflow_state !== 'exported') return ok({ export_id: started.id, state: exp.workflow_state, note: 'Still processing. Re-check later with get_content_export.' });
      const url = exp.attachment?.url;
      if (!url) return ok({ export_id: started.id, state: exp.workflow_state, note: 'Export finished but no attachment URL was returned.' });
      progress(96, 100, 'Downloading the archive');
      const saved = await saveDownload({ url, dir, name: exp.attachment.filename || `course-${a.course_id}.imscc`, contentType: 'application/zip' });
      progress(100, 100, 'Done');
      return ok({ saved_to: saved.saved_to, bytes: saved.bytes, export_id: started.id }, null, { links: [saved.link] });
    },
  });

  tool({
    name: 'semester_wrap_up', group: N,
    description: 'End-of-term checklist for every active course: current and final grades, missing work, anything still due before the course ends, and how many days until the course (and your access to its files) may close. Read-only; use export_all_courses to save copies.',
    handler: async (_a, { progress }) => {
      const courses = await canvas.paginate('/courses', { enrollment_state: 'active', include: ['total_scores', 'term'] }, { max: 40, ttl: 60000 });
      progress(1, 3, 'Checking missing work');
      const missing = await canvas.paginate('/users/self/missing_submissions', { filter: ['submittable'] }, { max: 200 }).catch(() => []);
      progress(2, 3, 'Checking what is still due');
      const planner = await canvas.paginate('/planner/items', { start_date: iso(new Date()), end_date: iso(daysFromNow(60)), filter: 'incomplete_items' }, { max: 300 }).catch(() => []);
      const now = Date.now();
      const rows = courses.map((c) => {
        const e = (c.enrollments || []).find((x) => x.type === 'student') || (c.enrollments || [])[0] || {};
        const end = c.end_at || c.term?.end_at || null;
        const daysLeft = end ? Math.ceil((new Date(end) - now) / 86400000) : null;
        const stillDue = planner.filter((p) => String(p.course_id) === String(c.id) && (!end || new Date(p.plannable?.due_at || p.plannable_date) <= new Date(end)));
        const miss = missing.filter((m) => String(m.course_id) === String(c.id));
        return omitEmpty({
          course: c.name, course_id: c.id, term: c.term?.name,
          current_grade: e.computed_current_grade ?? e.computed_current_score, final_grade_so_far: e.computed_final_grade ?? e.computed_final_score,
          course_ends: end ? friendly(end) : 'no end date set', days_until_end: daysLeft,
          missing_count: miss.length, missing: miss.slice(0, 5).map((m) => m.name),
          still_due_count: stillDue.length, still_due: stillDue.slice(0, 5).map((p) => `${p.plannable?.title || p.plannable?.name} (${friendly(p.plannable?.due_at || p.plannable_date)})`),
        });
      });
      rows.sort((x, y) => (x.days_until_end ?? 9999) - (y.days_until_end ?? 9999));
      progress(3, 3, 'Done');
      return ok({
        courses: rows,
        checklist: [
          'Finish or ask about anything still due or missing (missing work often counts as zero once grades are final).',
          'Save copies of notes, slides and your own submissions before courses close: export_all_courses packages every course, or download_all_course_files saves one course\'s files.',
          'Check grades with get_course_grade_breakdown and message a teacher (send_message) about anything that looks wrong before final grades post.',
        ],
      });
    },
  });

  const exportAll = async (a, { progress }) => {
    const courses = a.course_ids?.length ? a.course_ids.map((id) => ({ id })) : await activeCourses(40);
    const queued = [], failed = [];
    for (const [i, c] of courses.entries()) {
      progress(i, courses.length, `Queuing course ${c.name || c.id}`);
      try {
        const r = await canvas.post(`/courses/${c.id}/content_exports`, { export_type: 'common_cartridge', skip_notifications: true });
        queued.push({ course: c.name || c.id, course_id: c.id, export_id: r.id, state: r.workflow_state });
      } catch (e) { failed.push({ course: c.name || c.id, course_id: c.id, error: e.message }); }
    }
    return ok(omitEmpty({ queued, failed, next: 'Canvas packages each course in the background (a few minutes each). Check one with get_content_export (course_id, export_id) and download it from the link it gives, or run export_course_archive for a course to wait and download in one step.' }), `Queued ${queued.length} course export${queued.length === 1 ? '' : 's'}.`);
  };
  exportAll.preview = async (a) => {
    const courses = a.course_ids?.length ? a.course_ids : (await activeCourses(40)).map((c) => `${c.name} (${c.id})`);
    return { action: `Ask Canvas to package ${courses.length} course${courses.length === 1 ? '' : 's'} as archive files`, courses, note: 'Nothing in the courses changes and nobody else is notified; it just creates export files you can download.' };
  };
  tool({ name: 'export_all_courses', group: N, write: true, confirm: true, description: 'Ask Canvas to package every active course (or the ones you pick) as a downloadable .imscc archive, in one step. Nothing in the courses changes. Use before the term ends.', schema: { course_ids: z.array(z.string()).optional().describe('Course IDs; omit for all active courses.') }, handler: exportAll });
}
