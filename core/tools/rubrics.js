// Rubrics, outcomes, peer review. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';

export default function register(ctx) {
  const { tool, get, canvas, ok, assertClean, iso, daysFromNow, ID, COURSE } = ctx;

  const L = 'rubrics';

  get({ name: 'list_rubrics', group: L, description: 'Rubrics defined in a course.', path: (a) => `/courses/${a.course_id}/rubrics`, schema: { course_id: COURSE }, paginate: true, fields: ['id', 'title', 'points_possible', 'free_form_criterion_comments'] });
  get({ name: 'get_rubric', group: L, description: 'Full rubric with every criterion, rating level and point value. Read this BEFORE writing an assignment to know how it will be scored.', path: (a) => `/courses/${a.course_id}/rubrics/${a.rubric_id}`, schema: { course_id: COURSE, rubric_id: ID }, params: () => ({ include: ['assessments', 'associations'], style: 'full' }) });
  get({ name: 'get_my_rubric_assessment', group: L, comments: true, description: 'How a rubric was applied to your submission, criterion by criterion.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['full_rubric_assessment'] }), fields: ['id', 'score', 'grade', 'full_rubric_assessment'] });

  tool({
    name: 'list_my_peer_reviews', group: L,
    description: 'Peer reviews assigned to YOU that still need completing. Checks both the direct assignment endpoint and the Planner feed, because the direct endpoint alone misses items.',
    schema: { course_id: z.string().optional().describe('Omit to check all active courses') },
    handler: async (a) => {
      const out = [];
      let ids = a.course_id ? [a.course_id] : (await canvas.paginate('/courses', { enrollment_state: 'active' }, { max: 40 })).map((c) => String(c.id));
      for (const cid of ids) {
        try {
          const assignments = await canvas.paginate(`/courses/${cid}/assignments`, { include: ['submission'] }, { max: 100 });
          for (const asg of assignments.filter((x) => x.peer_reviews)) {
            try {
              const prs = await canvas.get(`/courses/${cid}/assignments/${asg.id}/peer_reviews`, { include: ['submission_comments'] });
              for (const pr of prs || []) out.push({ source: 'assignment', course_id: cid, assignment_id: asg.id, assignment: asg.name, peer_review_id: pr.id, workflow_state: pr.workflow_state, asset_id: pr.asset_id, due_at: asg.peer_reviews_assign_at || asg.due_at });
            } catch { /* not assigned to me */ }
          }
        } catch { /* course inaccessible */ }
      }
      try {
        const planner = await canvas.paginate('/planner/items', { start_date: iso(daysFromNow(-30)), end_date: iso(daysFromNow(60)) }, { max: 200 });
        for (const p of planner.filter((x) => x.plannable_type === 'assessment_request' || x.plannable_type === 'peer_review_sub_assignment')) {
          out.push({ source: 'planner', course_id: p.course_id, title: p.plannable?.title, due_at: p.plannable?.todo_date || p.plannable?.due_at, html_url: p.html_url, plannable_id: p.plannable_id });
        }
      } catch { /* planner unavailable */ }
      return ok({ count: out.length, peer_reviews: out, note: out.length ? null : 'Nothing found. Peer reviews are only visible once the instructor has assigned them.' });
    },
  });

  get({ name: 'get_peer_review_assignment', group: L, comments: true, description: 'Peer review records on a specific assignment.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/peer_reviews`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['user', 'submission_comments'] }) });
  const submitPeer = async (a) => { assertClean(a.comment, 'peer review comment'); const body = { comment: { text_comment: a.comment } }; if (a.rubric_assessment) body.rubric_assessment = a.rubric_assessment; return ok(await canvas.put(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/${a.student_id}`, body), 'Peer review submitted.'); };
  submitPeer.preview = async (a) => ({ action: 'SUBMIT a peer review of another student', course_id: a.course_id, assignment_id: a.assignment_id, reviewing_student_id: a.student_id, comment: a.comment, rubric_assessment: a.rubric_assessment || null, warning: 'The student you are reviewing will see this.' });
  tool({ name: 'submit_peer_review', group: L, write: true, confirm: true, description: 'Submit a peer review of a classmate: a comment and optionally a rubric assessment.', schema: { course_id: COURSE, assignment_id: ID, student_id: ID.describe('The student whose work you are reviewing'), comment: z.string(), rubric_assessment: z.record(z.string(), z.any()).optional() }, handler: submitPeer });

  get({ name: 'list_outcomes', group: L, description: 'Learning outcomes linked to a course.', path: (a) => `/courses/${a.course_id}/outcome_group_links`, schema: { course_id: COURSE }, params: () => ({ outcome_style: 'full' }), paginate: true });
  get({ name: 'get_outcome', group: L, description: 'Detail for one learning outcome including its mastery scale.', path: (a) => `/outcomes/${a.outcome_id}`, schema: { outcome_id: ID } });
  get({ name: 'list_outcome_groups', group: L, description: 'Outcome group hierarchy in a course.', path: (a) => `/courses/${a.course_id}/outcome_groups`, schema: { course_id: COURSE }, paginate: true });
  get({ name: 'get_my_outcome_results', group: L, description: 'Your mastery results against course learning outcomes.', path: (a) => `/courses/${a.course_id}/outcome_results`, schema: { course_id: COURSE }, params: () => ({ user_ids: ['self'], include: ['outcomes', 'alignments'] }) });
  get({ name: 'get_outcome_rollup', group: L, description: 'Rolled-up mastery scores per outcome for you.', path: (a) => `/courses/${a.course_id}/outcome_rollups`, schema: { course_id: COURSE }, params: () => ({ user_ids: ['self'], include: ['outcomes'] }) });
}
