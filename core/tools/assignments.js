// Assignments. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';

export default function register(ctx) {
  const { tool, get, canvas, ok, localize, relativeDue, iso, daysFromNow, ID, COURSE, LIMIT, ASSIGN_FIELDS, omitEmpty, fence, html2text, friendly, BASE } = ctx;

  const C = 'assignments';

  get({
    name: 'list_assignments', group: C,
    description: 'All assignments in a course with due dates, point values, and your submission status.',
    path: (a) => `/courses/${a.course_id}/assignments`,
    schema: { course_id: COURSE, bucket: z.enum(['past', 'overdue', 'undated', 'ungraded', 'unsubmitted', 'upcoming', 'future']).optional(), search_term: z.string().optional(), limit: LIMIT },
    params: (a) => ({ bucket: a.bucket, search_term: a.search_term, include: ['submission', 'score_statistics', 'all_dates'], order_by: 'due_at' }),
    paginate: true, max: 200, fields: ASSIGN_FIELDS,
  });
  get({ name: 'get_assignment', group: C, description: 'Full detail for one assignment including the description/prompt and rubric.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['submission', 'score_statistics', 'overrides', 'all_dates'] }), fenceFields: ['description'] });
  get({ name: 'list_assignment_groups', group: C, description: 'Assignment groups WITH their grade weights. Required to understand how your final grade is actually computed.', path: (a) => `/courses/${a.course_id}/assignment_groups`, schema: { course_id: COURSE, include_assignments: z.boolean().optional() }, params: (a) => ({ include: a.include_assignments ? ['assignments', 'submission'] : [] }), paginate: true });
  get({ name: 'get_assignment_group', group: C, description: 'One assignment group with its weight and drop rules.', path: (a) => `/courses/${a.course_id}/assignment_groups/${a.group_id}`, schema: { course_id: COURSE, group_id: ID }, params: () => ({ include: ['assignments'] }) });
  get({ name: 'list_assignment_overrides', group: C, description: 'Due-date overrides on an assignment (extensions granted to sections, groups, or individuals).', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/overrides`, schema: { course_id: COURSE, assignment_id: ID }, paginate: true });
  get({ name: 'get_my_override', group: C, description: 'The effective due/lock/unlock dates that apply to YOU for an assignment, accounting for section overrides.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['all_dates'] }), fields: ['id', 'name', 'due_at', 'lock_at', 'unlock_at', 'all_dates'] });
  get({ name: 'get_assignment_dates', group: C, description: 'Compact due/lock/unlock date list for every assignment in a course.', path: (a) => `/courses/${a.course_id}/assignments`, schema: { course_id: COURSE }, params: () => ({ include: ['all_dates'], order_by: 'due_at' }), paginate: true, fields: ['id', 'name', 'due_at', 'lock_at', 'unlock_at', 'points_possible'] });
  get({ name: 'get_score_statistics', group: C, description: 'Class mean/min/max/quartiles for an assignment. Canvas only exposes this once enough students have submitted and the instructor has not disabled it.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['score_statistics', 'submission'] }), fields: ['id', 'name', 'points_possible', 'score_statistics', 'submission'] });
  get({ name: 'get_late_policy', group: C, description: 'The course late policy: exact percentage deducted per late interval, and the floor for missing submissions.', path: (a) => `/courses/${a.course_id}/late_policy`, schema: { course_id: COURSE } });

  tool({
    name: 'list_missing_submissions', group: C,
    description: 'Every assignment across ALL courses that Canvas considers missing. Single cross-course call, far cheaper than looping courses.',
    schema: { limit: LIMIT },
    handler: async (a) => {
      const rows = await canvas.paginate('/users/self/missing_submissions', { include: ['planner_overrides', 'course'], filter: ['submittable'] }, { max: a.limit || 100 });
      return ok(rows.map((r) => ({
        assignment_id: r.id, name: r.name, course_id: r.course_id, course: r.course?.name,
        points_possible: r.points_possible, due_at: r.due_at, due_local: localize(r.due_at),
        overdue_by: relativeDue(r.due_at), html_url: r.html_url,
      })));
    },
  });

  tool({
    name: 'list_upcoming_assignments', group: C,
    description: 'Assignments due within the next N days across all active courses, sorted soonest-first. Uses the Planner feed, which is the same source the Canvas student dashboard uses.',
    schema: { days: z.number().int().positive().optional().describe('Default 7'), include_completed: z.boolean().optional() },
    output: {
      days: z.number(),
      items: z.array(z.object({
        type: z.string().optional(), plannable_id: z.string().optional(), title: z.string(), course_id: z.string().optional(),
        due_at: z.string(), due_local: z.string().optional(), due_in: z.string().optional(), points: z.number().optional(),
        submitted: z.boolean().optional(), missing: z.boolean().optional(), graded: z.boolean().optional(), html_url: z.string().optional(),
      })),
    },
    handler: async (a) => {
      const days = a.days || 7;
      const items = await canvas.paginate('/planner/items', {
        start_date: iso(new Date()), end_date: iso(daysFromNow(days)),
        filter: a.include_completed ? undefined : 'incomplete_items',
      }, { max: 200, ttl: 30000 });
      const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
      const bool = (v) => (typeof v === 'boolean' ? v : undefined);
      const rows = items.map((i) => {
        const due = i.plannable?.due_at || i.plannable?.todo_date;
        return omitEmpty({
          type: i.plannable_type, plannable_id: i.plannable_id != null ? String(i.plannable_id) : undefined,
          title: String(i.plannable?.title || i.plannable?.name || '(untitled)'),
          course_id: i.course_id != null ? String(i.course_id) : undefined, due_at: due,
          due_local: localize(due), due_in: relativeDue(due), points: num(i.plannable?.points_possible),
          submitted: bool(i.submissions?.submitted), missing: bool(i.submissions?.missing), graded: bool(i.submissions?.graded),
          html_url: i.html_url ? (/^https?:/.test(i.html_url) ? i.html_url : `${BASE}${i.html_url}`) : undefined,
        });
      }).filter((r) => r.due_at);
      rows.sort((x, y) => new Date(x.due_at) - new Date(y.due_at));
      return ok(rows, null, { structured: { days, items: rows } });
    },
  });

  tool({
    name: 'list_overdue_assignments', group: C,
    description: 'Assignments past their due date that you have not submitted, across all active courses.',
    schema: { limit: LIMIT },
    handler: async (a) => {
      const courses = await canvas.paginate('/courses', { enrollment_state: 'active' }, { max: 50 });
      const out = [];
      for (const c of courses) {
        try {
          const rows = await canvas.paginate(`/courses/${c.id}/assignments`, { bucket: 'overdue', include: ['submission'] }, { max: 50 });
          for (const r of rows) out.push({ course: c.name, course_id: c.id, assignment_id: r.id, name: r.name, due_at: r.due_at, overdue_by: relativeDue(r.due_at), points_possible: r.points_possible, html_url: r.html_url });
        } catch { /* course may not expose assignments */ }
      }
      out.sort((x, y) => new Date(x.due_at) - new Date(y.due_at));
      return ok(out.slice(0, a.limit || 100));
    },
  });

  const SUBMIT_AS = {
    online_text_entry: 'type it into a text box', online_upload: 'upload a file', online_url: 'submit a website link',
    media_recording: 'record or upload audio/video', student_annotation: 'mark up a document inside Canvas', online_quiz: 'take a Canvas quiz',
    discussion_topic: 'post in a discussion', external_tool: 'use an external tool linked from the assignment', on_paper: 'hand it in on paper', none: 'nothing to submit online',
  };

  /** Late policy in one sentence, e.g. "late work loses 10% per day, down to no less than 50%". */
  function describeLatePolicy(p) {
    if (!p) return null;
    const late = p.late_submission_deduction_enabled
      ? `late work loses ${p.late_submission_deduction}% per ${p.late_submission_interval || 'day'}${p.late_submission_minimum_percent_enabled ? `, down to no less than ${p.late_submission_minimum_percent}%` : ''}`
      : 'no automatic late penalty';
    const missing = p.missing_submission_deduction_enabled ? `; missing work is recorded as ${100 - Number(p.missing_submission_deduction || 0)}%` : '';
    return `${late}${missing}`;
  }

  tool({
    name: 'assignment_brief', group: C,
    description: 'Everything needed to start an assignment, in one call: the instructions as clean text, due and lock dates, how to submit, attempts, the rubric, the late policy, linked files, group and peer-review details, and your current status.',
    schema: { course_id: COURSE, assignment_id: ID },
    handler: async (a) => {
      const asg = await canvas.get(`/courses/${a.course_id}/assignments/${a.assignment_id}`, { include: ['submission', 'all_dates', 'can_submit'] });
      const course = await canvas.get(`/courses/${a.course_id}`, null, { ttl: 600000 }).catch(() => null);
      const policy = await canvas.get(`/courses/${a.course_id}/late_policy`, null, { ttl: 600000 }).then((r) => r?.late_policy).catch(() => null);
      const fileIds = [...new Set([...String(asg.description || '').matchAll(/\/files\/(\d+)/g)].map((m) => m[1]))].slice(0, 8);
      const files = [];
      for (const id of fileIds) {
        try { const f = await canvas.get(`/files/${id}`, null, { ttl: 600000 }); files.push({ file_id: f.id, name: f.display_name, size_kb: Math.round((f.size || 0) / 1024), read_it_with: 'read_course_file' }); } catch { /* not shared with you */ }
      }
      const s = asg.submission || {};
      const status = s.excused ? 'excused'
        : s.workflow_state === 'graded' ? `graded: ${s.score ?? s.grade}${asg.points_possible ? ` / ${asg.points_possible}` : ''}`
        : s.submitted_at ? `submitted ${friendly(s.submitted_at)}, not graded yet` : s.missing ? 'missing' : 'not submitted yet';
      const rubric = (asg.rubric || []).map((c) => omitEmpty({
        criterion: c.description, points: c.points,
        details: c.long_description ? fence(html2text(c.long_description), 'rubric criterion') : undefined,
        ratings: (c.ratings || []).map((r) => `${r.description} (${r.points} pts)${r.long_description ? `: ${html2text(r.long_description)}` : ''}`),
      }));
      const types = (asg.submission_types || []).map((t) => SUBMIT_AS[t] || t);
      return ok(omitEmpty({
        assignment: asg.name, course: course?.name, url: asg.html_url,
        points_possible: asg.points_possible, grading_type: asg.grading_type,
        due: friendly(asg.due_at) || 'no due date', due_at: asg.due_at,
        available_from: friendly(asg.unlock_at), closes: friendly(asg.lock_at),
        locked: asg.locked_for_user ? (asg.lock_explanation ? html2text(asg.lock_explanation) : true) : undefined,
        your_status: status,
        how_to_submit: types,
        allowed_file_types: asg.allowed_extensions?.length ? asg.allowed_extensions : undefined,
        attempts: asg.allowed_attempts && asg.allowed_attempts > 0 ? `${s.attempt || 0} of ${asg.allowed_attempts} used` : 'unlimited',
        word_count_hint: types.includes(SUBMIT_AS.online_text_entry) ? 'Check the instructions for a word count.' : undefined,
        group_assignment: asg.group_category_id ? 'Yes: one submission counts for your whole group.' : undefined,
        peer_reviews: asg.peer_reviews ? omitEmpty({ required: true, how_many: asg.peer_review_count, assigned_on: friendly(asg.peer_reviews_assign_at) }) : undefined,
        late_policy: describeLatePolicy(policy) || undefined,
        rubric: rubric.length ? rubric : undefined,
        rubric_total_points: rubric.length ? rubric.reduce((t, c) => t + Number(c.points || 0), 0) : undefined,
        linked_files: files.length ? files : undefined,
        quiz_id: asg.quiz_id, discussion_topic_id: asg.discussion_topic?.id,
        external_tool: asg.external_tool_tag_attributes?.url,
        instructions: asg.description ? fence(html2text(asg.description), `assignment: ${asg.name}`) : 'No written instructions on this assignment.',
      }));
    },
  });
}
