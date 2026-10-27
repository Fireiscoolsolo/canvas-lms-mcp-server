// Pure grade math used by the grade tools in index.js. No Canvas calls here, so it can be unit tested.

const isGraded = (s) => s && s.score !== null && s.score !== undefined && s.workflow_state === 'graded';

/** Per-group breakdown of a course grade, from assignment groups, your submissions and the course record. */
export function calculateGradeBreakdown(groups, subs, course) {
  const byAssignment = new Map(subs.map((s) => [String(s.assignment_id), s]));
  const weighted = groups.some((g) => Number(g.group_weight) > 0);
  const out = groups.map((g) => {
    let earned = 0, possible = 0;
    const items = (g.assignments || []).map((asg) => {
      const s = byAssignment.get(String(asg.id));
      const graded = isGraded(s);
      if (graded && !asg.omit_from_final_grade) { earned += Number(s.score); possible += Number(asg.points_possible || 0); }
      return { assignment_id: asg.id, name: asg.name, points_possible: asg.points_possible, score: s?.score ?? null, status: graded ? 'graded' : (s?.submitted_at ? 'submitted, ungraded' : (s?.missing ? 'missing' : 'not submitted')), due_at: asg.due_at };
    });
    const pct = possible > 0 ? (earned / possible) * 100 : null;
    return { group: g.name, group_id: g.id, weight_percent: weighted ? g.group_weight : null, drop_rules: g.rules, graded_points_earned: earned, graded_points_possible: possible, group_percent: pct === null ? null : Number(pct.toFixed(2)), weighted_contribution: weighted && pct !== null ? Number(((pct / 100) * Number(g.group_weight)).toFixed(2)) : null, assignments: items };
  });
  const e = (course.enrollments || [])[0] || {};
  return {
    course: course.name, weighting: weighted ? 'weighted by assignment group' : 'total points',
    canvas_reported_current: { score: e.computed_current_score, grade: e.computed_current_grade },
    canvas_reported_final: { score: e.computed_final_score, grade: e.computed_final_grade },
    groups: out,
    note: 'current = graded work only. final = treats ungraded as zero. Drop rules are reported but not applied in this breakdown; Canvas applies them in its own totals.',
  };
}

/** Average needed on remaining ungraded work to reach targetPercent. Excused and omitted assignments are skipped. */
export function calculateNeededScore(groups, targetPercent, courseId) {
  const weighted = groups.some((g) => Number(g.group_weight) > 0);
  let earned = 0, gradedPossible = 0, remaining = 0;
  const remainingItems = [];
  for (const g of groups) {
    for (const asg of g.assignments || []) {
      if (asg.omit_from_final_grade) continue;
      const pts = Number(asg.points_possible || 0);
      const s = asg.submission;
      if (s?.excused) continue;
      if (isGraded(s)) { earned += Number(s.score); gradedPossible += pts; }
      else if (pts > 0) { remaining += pts; remainingItems.push({ name: asg.name, points: pts, due_at: asg.due_at }); }
    }
  }
  const total = gradedPossible + remaining;
  const needPoints = (targetPercent / 100) * total - earned;
  const needPct = remaining > 0 ? (needPoints / remaining) * 100 : null;
  return {
    course_id: courseId, weighting: weighted ? 'WEIGHTED by group (this estimate uses raw points and will be approximate)' : 'total points (estimate is exact)',
    points_earned: earned, points_graded_so_far: gradedPossible, points_remaining: remaining, total_points_in_course: total,
    current_percent: gradedPossible > 0 ? Number(((earned / gradedPossible) * 100).toFixed(2)) : null,
    target_percent: targetPercent,
    points_needed_from_remaining: Number(needPoints.toFixed(2)),
    required_average_on_remaining_percent: needPct === null ? null : Number(needPct.toFixed(2)),
    verdict: needPct === null ? 'No ungraded work left; the grade is locked in.' : needPct > 100 ? 'Not reachable even with perfect scores on everything remaining.' : needPct <= 0 ? 'Already secured regardless of remaining work.' : 'Reachable.',
    remaining_items: remainingItems,
    caveat: weighted ? 'This course uses group weighting. For an exact answer use what_if_grade, which makes Canvas do the real calculation.' : null,
  };
}

/** Shapes Canvas's what-if response. Accepts `grades` as either an array or a single object. */
export function formatWhatIfGrade(response, score) {
  const g = Array.isArray(response?.grades) ? response.grades[0] : response?.grades;
  return {
    tested_score: score,
    resulting_current: g?.current, resulting_final: g?.final,
    current_by_group: g?.current_groups, final_by_group: g?.final_groups,
    submission: response?.submission,
    note: 'This is a what-if only. Call reset_what_if_grades to clear it.',
  };
}
