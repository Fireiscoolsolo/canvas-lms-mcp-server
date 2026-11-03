// Grades and analytics. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';
import { calculateGpa, calculateGradeBreakdown, calculateNeededScore, formatWhatIfGrade, calculateScenarios, cutoffsFromStandard } from '../grade-calculators.js';

export default function register(ctx) {
  const { tool, get, canvas, ok, omitEmpty, relativeDue, ID, COURSE } = ctx;

  const E = 'grades';

  tool({
    name: 'get_all_grades', group: E,
    description: 'Current and final grades for every active course in one call, including unposted variants where visible.',
    output: {
      courses: z.array(z.object({
        course_id: z.string(), course: z.string(), code: z.string().optional(), term: z.string().optional(),
        current_score: z.number().optional(), current_grade: z.string().optional(),
        final_score: z.number().optional(), final_grade: z.string().optional(),
        unposted_current_score: z.number().optional(), note: z.string().optional(),
      })),
    },
    handler: async () => {
      const courses = await canvas.paginate('/courses', { enrollment_state: 'active', include: ['total_scores', 'current_grading_period_scores', 'term'] }, { max: 60, ttl: 30000 });
      const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
      const str = (v) => (v === null || v === undefined || v === '' ? undefined : String(v));
      const rows = courses.map((c) => {
        const e = (c.enrollments || []).find((x) => x.type === 'student') || (c.enrollments || [])[0] || {};
        return omitEmpty({
          course_id: String(c.id), course: String(c.name || c.course_code || c.id), code: str(c.course_code), term: str(c.term?.name),
          current_score: num(e.computed_current_score), current_grade: str(e.computed_current_grade),
          final_score: num(e.computed_final_score), final_grade: str(e.computed_final_grade),
          unposted_current_score: num(e.unposted_current_score),
          note: e.computed_current_score === undefined ? 'Instructor may be hiding totals for this course.' : undefined,
        });
      });
      return ok(rows, null, { structured: { courses: rows } });
    },
  });

  tool({
    name: 'calculate_gpa', group: E,
    description: 'Your GPA on a 4.0 scale from your current course grades, weighted by credit hours, with optional what-if grades.',
    schema: {
      credits: z.record(z.string(), z.number().positive()).optional(),
      default_credits: z.number().positive().optional(),
      what_if: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      extra_points: z.record(z.string(), z.number().min(0).max(2)).optional(),
      use_final_score: z.boolean().optional(),
    },
    handler: async (a) => {
      const courses = await canvas.paginate('/courses', { enrollment_state: 'active', include: ['total_scores', 'term'] }, { max: 60, ttl: 30000 });
      const rows = courses.map((c) => {
        const e = (c.enrollments || []).find((x) => x.type === 'student') || (c.enrollments || [])[0] || {};
        return {
          course_id: c.id, course: c.name, code: c.course_code,
          score: a.use_final_score ? e.computed_final_score : e.computed_current_score,
          grade: a.use_final_score ? e.computed_final_grade : e.computed_current_grade,
        };
      });
      return ok(omitEmpty(calculateGpa(rows, { credits: a.credits, defaultCredits: a.default_credits, whatIf: a.what_if, extraPoints: a.extra_points })));
    },
  });

  tool({
    name: 'get_course_grade_breakdown', group: E,
    description: 'Full grade math for one course: every assignment group with its weight, your points earned vs possible per group, and the weighted contribution of each. This is what Canvas shows you, decomposed.',
    schema: { course_id: COURSE },
    handler: async (a) => {
      const [groups, subs, course] = [
        await canvas.paginate(`/courses/${a.course_id}/assignment_groups`, { include: ['assignments'] }, { max: 50 }),
        await canvas.paginate(`/courses/${a.course_id}/students/submissions`, { student_ids: ['self'], per_page: 100 }, { max: 300 }),
        await canvas.get(`/courses/${a.course_id}`, { include: ['total_scores'] }),
      ];
      return ok(calculateGradeBreakdown(groups, subs, course));
    },
  });

  tool({
    name: 'what_if_grade', group: E, write: true,
    description: 'Enter a hypothetical score on an assignment and get your fully recalculated course grade back, with assignment-group weighting and drop rules applied by Canvas itself. This writes a student-only what-if score to the submission; it is NOT a real grade and nobody else sees it. Reverse with reset_what_if_grades. Canvas flags this as expensive, so use it sparingly.',
    schema: { submission_id: ID.describe('Submission ID (from get_my_submission or list_my_submissions)'), score: z.number().describe('Hypothetical score to test') },
    handler: async (a) => {
      const r = await canvas.put(`/submissions/${a.submission_id}/what_if_grades`, { student_entered_score: a.score });
      return ok(formatWhatIfGrade(r, a.score));
    },
  });
  tool({ name: 'reset_what_if_grades', group: E, write: true, description: 'Clear all what-if scores in a course and recalculate back to your real grades.', schema: { course_id: COURSE }, handler: async (a) => ok(await canvas.put(`/courses/${a.course_id}/what_if_grades/reset`), 'What-if scores cleared.') });

  get({ name: 'get_grading_standard', group: E, description: 'The letter-grade cutoff scheme for a course (what percentage is an A-, B+, etc).', path: (a) => `/courses/${a.course_id}/grading_standards`, schema: { course_id: COURSE }, paginate: true });
  get({ name: 'list_grading_periods', group: E, description: 'Grading periods for a course (used where grades are split by term segment).', path: (a) => `/courses/${a.course_id}/grading_periods`, schema: { course_id: COURSE } });
  get({ name: 'get_my_assignment_analytics', group: E, description: 'Per-assignment analytics for you: your score against the class MEDIAN, min and max, plus on-time status. One of the most useful endpoints Canvas exposes to students.', path: (a) => `/courses/${a.course_id}/analytics/users/self/assignments`, schema: { course_id: COURSE } });
  get({ name: 'get_my_activity_analytics', group: E, description: 'Your page views and participations in a course, bucketed by day.', path: (a) => `/courses/${a.course_id}/analytics/users/self/activity`, schema: { course_id: COURSE } });
  get({ name: 'get_my_communication_analytics', group: E, description: 'Message volume between you and the instructor in a course, by day.', path: (a) => `/courses/${a.course_id}/analytics/users/self/communication`, schema: { course_id: COURSE } });
  get({ name: 'get_unposted_grades', group: E, description: 'Scores that exist but have not been posted/released, where your enrollment exposes them.', path: '/users/self/enrollments', schema: { course_id: z.string().optional() }, params: (a) => ({ state: ['active'], type: ['StudentEnrollment'], course_id: a.course_id }), paginate: true, fields: ['id', 'course_id', 'grades', 'computed_current_score', 'computed_final_score'] });

  tool({
    name: 'compute_needed_score', group: E,
    description: 'Pure math, no writes: given a target final percentage, compute what average you need on remaining ungraded work in a course. Accounts for assignment-group weighting.',
    schema: { course_id: COURSE, target_percent: z.number().describe('Target final grade percentage, e.g. 90') },
    handler: async (a) => {
      const groups = await canvas.paginate(`/courses/${a.course_id}/assignment_groups`, { include: ['assignments', 'submission'] }, { max: 50 });
      return ok(calculateNeededScore(groups, a.target_percent, a.course_id));
    },
  });

  tool({
    name: 'grade_impact_ranking', group: E,
    description: 'Rank ungraded/upcoming assignments in a course by how much each point moves your final grade. Tells you where effort actually pays.',
    schema: { course_id: COURSE },
    handler: async (a) => {
      const groups = await canvas.paginate(`/courses/${a.course_id}/assignment_groups`, { include: ['assignments', 'submission'] }, { max: 50 });
      const weighted = groups.some((g) => Number(g.group_weight) > 0);
      let totalPoints = 0;
      for (const g of groups) for (const asg of g.assignments || []) if (!asg.omit_from_final_grade) totalPoints += Number(asg.points_possible || 0);
      const rows = [];
      for (const g of groups) {
        const gw = Number(g.group_weight || 0);
        let groupTotal = 0;
        for (const asg of g.assignments || []) if (!asg.omit_from_final_grade) groupTotal += Number(asg.points_possible || 0);
        for (const asg of g.assignments || []) {
          const s = asg.submission;
          const graded = s && s.score !== null && s.score !== undefined && s.workflow_state === 'graded';
          if (graded || asg.omit_from_final_grade) continue;
          const pts = Number(asg.points_possible || 0);
          if (!pts) continue;
          const impact = weighted && groupTotal > 0 ? (pts / groupTotal) * gw : (totalPoints > 0 ? (pts / totalPoints) * 100 : 0);
          rows.push({ assignment_id: asg.id, name: asg.name, group: g.name, points_possible: pts, due_at: asg.due_at, due_in: relativeDue(asg.due_at), max_final_grade_swing_percent: Number(impact.toFixed(2)) });
        }
      }
      rows.sort((x, y) => y.max_final_grade_swing_percent - x.max_final_grade_swing_percent);
      return ok({ course_id: a.course_id, weighting: weighted ? 'weighted by group' : 'total points', ranked: rows, note: 'Swing = percentage points of final grade between scoring 0 and scoring full marks.' });
    },
  });

  tool({
    name: 'get_grade_trend', group: E,
    description: 'Chronological list of graded assignments in a course with a running average, showing whether your grade is climbing or sliding.',
    schema: { course_id: COURSE },
    handler: async (a) => {
      const subs = await canvas.paginate(`/courses/${a.course_id}/students/submissions`, { student_ids: ['self'], include: ['assignment'], per_page: 100 }, { max: 300 });
      const graded = subs.filter((s) => s.score !== null && s.score !== undefined && s.workflow_state === 'graded' && s.assignment?.points_possible)
        .sort((x, y) => new Date(x.graded_at || x.submitted_at || 0) - new Date(y.graded_at || y.submitted_at || 0));
      let e = 0, p = 0;
      const rows = graded.map((s) => {
        e += Number(s.score); p += Number(s.assignment.points_possible);
        return { name: s.assignment.name, graded_at: s.graded_at, score: s.score, out_of: s.assignment.points_possible, this_assignment_percent: Number(((s.score / s.assignment.points_possible) * 100).toFixed(1)), running_percent: Number(((e / p) * 100).toFixed(2)) };
      });
      const first = rows[0]?.running_percent, last = rows[rows.length - 1]?.running_percent;
      return ok({ course_id: a.course_id, graded_count: rows.length, trend: first !== undefined && last !== undefined ? (last > first ? 'improving' : last < first ? 'declining' : 'flat') : 'insufficient data', timeline: rows });
    },
  });

  tool({
    name: 'final_grade_scenarios', group: E,
    description: 'What-if planning for a whole course: your projected final grade if you average 100, 90, 80, 70 or 60% on everything not graded yet, and the average you need on the rest for each letter grade. Uses the course\'s assignment-group weights and its own letter cutoffs when Canvas shares them. Read-only.',
    schema: {
      course_id: COURSE,
      targets: z.array(z.number().min(0).max(100)).optional().describe('Your own target percentages instead of letter grades, e.g. [93, 85].'),
    },
    handler: async (a) => {
      const groups = await canvas.paginate(`/courses/${a.course_id}/assignment_groups`, { include: ['assignments', 'submission'] }, { max: 50 });
      const course = await canvas.get(`/courses/${a.course_id}`, null, { ttl: 600000 });
      let cutoffs;
      let source = 'the usual scale (A 90, B 80, C 70, D 60), because this course does not share its own';
      if (a.targets?.length) {
        cutoffs = [...a.targets].sort((x, y) => y - x).map((t) => [`${t}%`, t]);
        source = 'your targets';
      } else if (course.grading_standard_id) {
        const standards = await canvas.paginate(`/courses/${a.course_id}/grading_standards`, null, { max: 50 }).catch(() => []);
        const std = standards.find((s) => String(s.id) === String(course.grading_standard_id));
        if (std) { cutoffs = cutoffsFromStandard(std); source = `this course's grading scheme${std.title ? ` (${std.title})` : ''}`; }
      }
      return ok({ course: course.name, course_id: a.course_id, cutoffs_from: source, ...calculateScenarios(groups, cutoffs ? { cutoffs } : {}) });
    },
  });
}
