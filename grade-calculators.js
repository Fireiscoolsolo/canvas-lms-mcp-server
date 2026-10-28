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

// Standard US 4.0 scale. Letters Canvas shows (from a course's grading scheme) win over the percent cutoffs.
const LETTER_POINTS = { 'A+': 4.0, A: 4.0, 'A-': 3.7, 'B+': 3.3, B: 3.0, 'B-': 2.7, 'C+': 2.3, C: 2.0, 'C-': 1.7, 'D+': 1.3, D: 1.0, 'D-': 0.7, F: 0 };
const PERCENT_CUTOFFS = [[93, 'A'], [90, 'A-'], [87, 'B+'], [83, 'B'], [80, 'B-'], [77, 'C+'], [73, 'C'], [70, 'C-'], [67, 'D+'], [63, 'D'], [60, 'D-'], [0, 'F']];

export function letterFromPercent(pct) {
  return PERCENT_CUTOFFS.find(([min]) => pct >= min)[1];
}

/** Find a per-course setting by course ID, name or code, ignoring case. */
function lookup(map, row) {
  if (!map) return undefined;
  const keys = [row.course_id, row.course, row.code].filter(Boolean).map((k) => String(k).toLowerCase());
  for (const [k, v] of Object.entries(map)) if (keys.includes(String(k).toLowerCase())) return v;
  return undefined;
}

/**
 * GPA across courses on a 4.0 scale, weighted by credit hours.
 * rows: [{ course_id, course, code, score (percent), grade (letter or null) }]
 * credits / what_if / extra_points: maps keyed by course ID, name or code. what_if values are a letter or a percent.
 */
export function calculateGpa(rows, { credits, defaultCredits = 3, whatIf, extraPoints } = {}) {
  const counted = [];
  const excluded = [];
  for (const r of rows) {
    const override = lookup(whatIf, r);
    let letter;
    let source = 'canvas';
    if (override !== undefined) {
      source = 'what-if';
      letter = typeof override === 'number' || /^\d+(\.\d+)?%?$/.test(String(override).trim())
        ? letterFromPercent(parseFloat(override))
        : String(override).trim().toUpperCase();
    } else if (r.grade && LETTER_POINTS[String(r.grade).trim().toUpperCase()] !== undefined) {
      letter = String(r.grade).trim().toUpperCase();
    } else if (typeof r.score === 'number') {
      letter = letterFromPercent(r.score);
    } else if (r.grade) {
      letter = String(r.grade).trim().toUpperCase(); // e.g. P or Complete; excluded below with the reason
    }
    if (!letter || LETTER_POINTS[letter] === undefined) {
      excluded.push({ course: r.course, reason: letter ? `"${letter}" isn't a letter grade on the 4.0 scale` : 'No grade shown yet' });
      continue;
    }
    const creditHours = Number(lookup(credits, r) ?? defaultCredits);
    const bonus = Number(lookup(extraPoints, r) || 0);
    counted.push({ course: r.course, score: r.score ?? null, letter, points: LETTER_POINTS[letter] + bonus, credits: creditHours, source });
  }
  const totalCredits = counted.reduce((s, c) => s + c.credits, 0);
  const gpa = totalCredits ? counted.reduce((s, c) => s + c.points * c.credits, 0) / totalCredits : null;
  return {
    gpa: gpa === null ? null : Number(gpa.toFixed(2)),
    scale: extraPoints && Object.keys(extraPoints).length ? '4.0 scale with extra points (weighted)' : '4.0 scale (unweighted)',
    total_credits: totalCredits,
    courses: counted,
    excluded,
    note: credits ? undefined : `Every course counts as ${defaultCredits} credits. Pass credits per course for an exact GPA.`,
  };
}
