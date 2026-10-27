import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateGradeBreakdown,
  calculateNeededScore,
  formatWhatIfGrade
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
