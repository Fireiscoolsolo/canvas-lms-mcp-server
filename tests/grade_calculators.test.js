import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateGpa,
  calculateGradeBreakdown,
  calculateNeededScore,
  formatWhatIfGrade,
  letterFromPercent
} from '../grade-calculators.js';

test('calculates weighted grade contribution', () => {
  const groups = [{
    id: 1,
    name: 'Assignments',
    group_weight: 40,
    assignments: [{
      id: 101,
      name: 'Homework',
      points_possible: 100
    }]
  }];

  const submissions = [{
    assignment_id: 101,
    score: 80,
    workflow_state: 'graded'
  }];

  const course = {
    name: 'Software Engineering',
    enrollments: []
  };

  const result = calculateGradeBreakdown(groups, submissions, course);

  assert.equal(result.groups[0].weighted_contribution, 32);
});

test('detects impossible grade target', () => {
  const groups = [{
    group_weight: 0,
    assignments: [
      {
        id: 1,
        points_possible: 100,
        submission: {
          score: 0,
          workflow_state: 'graded'
        }
      },
      {
        id: 2,
        points_possible: 100,
        submission: null
      }
    ]
  }];

  const result = calculateNeededScore(groups, 90, 1);

  assert.equal(
    result.verdict,
    'Not reachable even with perfect scores on everything remaining.'
  );
});

test('reports drop-lowest rules without applying them locally', () => {
  const rules = { drop_lowest: 1, drop_highest: 0, never_drop: [] };

  const groups = [{
    id: 1,
    name: 'Assignments',
    group_weight: 40,
    rules,
    assignments: [
      { id: 101, name: 'Task 1', points_possible: 100 },
      { id: 102, name: 'Task 2', points_possible: 100 }
    ]
  }];

  const submissions = [
    { assignment_id: 101, score: 80, workflow_state: 'graded' },
    { assignment_id: 102, score: 20, workflow_state: 'graded' }
  ];

  const result = calculateGradeBreakdown(
    groups,
    submissions,
    { name: 'Math', enrollments: [] }
  );

  assert.deepEqual(result.groups[0].drop_rules, rules);
  assert.equal(result.groups[0].group_percent, 50);
});

test('calculates remaining scores for ungraded assignments', () => {
  const groups = [{
    group_weight: 0,
    assignments: [
      {
        id: 1,
        name: 'Quiz',
        points_possible: 100,
        submission: { score: 70, workflow_state: 'graded' }
      },
      {
        id: 2,
        name: 'Final Exam',
        points_possible: 100,
        submission: { score: null, workflow_state: 'submitted' }
      }
    ]
  }];

  const result = calculateNeededScore(groups, 80, 1);

  assert.equal(result.points_earned, 70);
  assert.equal(result.points_remaining, 100);
  assert.equal(result.required_average_on_remaining_percent, 90);
  assert.equal(result.remaining_items.length, 1);
});

test('excludes excused assignments from remaining work', () => {
  const groups = [{
    group_weight: 0,
    assignments: [
      {
        id: 1,
        name: 'Quiz',
        points_possible: 100,
        submission: { score: 80, workflow_state: 'graded' }
      },
      {
        id: 2,
        name: 'Excused Quiz',
        points_possible: 100,
        submission: { score: null, excused: true }
      }
    ]
  }];

  const result = calculateNeededScore(groups, 80, 1);

  assert.equal(result.points_remaining, 0);
  assert.equal(result.total_points_in_course, 100);
  assert.equal(result.remaining_items.length, 0);
});

test('formats Canvas what-if grade response correctly', () => {
  const response = {
    grades: [{
      current: 85,
      final: 82,
      current_groups: { Assignments: 90 },
      final_groups: { Assignments: 85 }
    }],
    submission: { id: 123 }
  };

  const result = formatWhatIfGrade(response, 95);

  assert.equal(result.tested_score, 95);
  assert.equal(result.resulting_current, 85);
  assert.equal(result.resulting_final, 82);
  assert.deepEqual(result.current_by_group, { Assignments: 90 });
  assert.deepEqual(result.final_by_group, { Assignments: 85 });
  assert.deepEqual(result.submission, { id: 123 });
});

test('calculateGpa weights by credits, prefers Canvas letters and excludes pass-fail', () => {
  const rows = [
    { course_id: '1', course: 'Calculus I', code: 'MATH151', score: 91.2, grade: null },
    { course_id: '2', course: 'English', code: 'ENG101', score: 88, grade: 'B+' },
    { course_id: '3', course: 'Gym', code: 'PE', score: null, grade: 'P' },
    { course_id: '4', course: 'New class', code: 'NEW', score: null, grade: null },
  ];
  const r = calculateGpa(rows, { credits: { 'calculus i': 4, ENG101: 3 } });
  assert.equal(r.gpa, 3.53); // (3.7*4 + 3.3*3) / 7
  assert.equal(r.total_credits, 7);
  assert.deepEqual(r.courses.map((c) => c.letter), ['A-', 'B+']);
  assert.deepEqual(r.excluded.map((e) => e.course), ['Gym', 'New class']);
  assert.match(r.excluded[0].reason, /"P" isn't a letter grade/);
  assert.equal(r.note, undefined);
});

test('calculateGpa what-if, default credits and weighted extra points', () => {
  const rows = [{ course_id: '1', course: 'Chem', score: 75, grade: null }, { course_id: '2', course: 'AP Bio', score: 95, grade: null }];
  const base = calculateGpa(rows);
  assert.equal(base.gpa, 3); // C (2.0) and A (4.0), equal default credits
  assert.match(base.note, /3 credits/);
  assert.equal(calculateGpa(rows, { whatIf: { chem: 'B' } }).gpa, 3.5);
  assert.equal(calculateGpa(rows, { whatIf: { 1: 91 } }).courses[0].letter, 'A-');
  const weighted = calculateGpa(rows, { extraPoints: { 'AP Bio': 1 } });
  assert.equal(weighted.gpa, 3.5);
  assert.match(weighted.scale, /weighted/);
  assert.equal(calculateGpa([]).gpa, null);
});

test('letterFromPercent cutoffs', () => {
  assert.deepEqual([100, 93, 92.9, 87, 83, 80, 77, 73, 70, 67, 63, 60, 59.9].map(letterFromPercent), ['A', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F']);
});
