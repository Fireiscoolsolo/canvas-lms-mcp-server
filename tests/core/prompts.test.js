// The ready-made prompts in the AI app's prompt menu. profiles.test.js checks that every tool a prompt names is in
// its needs; these check what the study prompts ask the AI to do. Fake Canvas only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './fake-canvas.js';

const said = async (client, name, args) => (await client.getPrompt({ name, arguments: args })).messages.map((m) => m.content.text).join('\n');

test('the four study prompts are offered with a title and a description', async () => {
  const { client, close } = await connect();
  try {
    const list = (await client.listPrompts()).prompts;
    for (const name of ['quiz_me', 'check_my_draft', 'weekly_review', 'feedback_review']) {
      const p = list.find((x) => x.name === name);
      assert.ok(p?.title && p?.description, name);
    }
  } finally { await close(); }
});

test('quiz_me asks one question at a time from the course\'s own material and waits for an answer', async () => {
  const { client, close } = await connect();
  try {
    const text = await said(client, 'quiz_me', { course: 'Biology 101', topic: 'cell membranes' });
    assert.match(text, /cell membranes/);
    assert.match(text, /Biology 101/);
    assert.match(text, /one question at a time/i);
    assert.match(text, /wait for my answer/i);
    assert.match(text, /read_course_file/);
    assert.match(await said(client, 'quiz_me', { course: 'Biology 101' }), /most recent module/i, 'no topic means the latest material');
  } finally { await close(); }
});

test('check_my_draft compares a pasted draft with the instructions and rubric, and never rewrites it', async () => {
  const { client, close } = await connect();
  try {
    const text = await said(client, 'check_my_draft', { course: 'English 2', assignment: 'Essay 2' });
    assert.match(text, /Essay 2/);
    assert.match(text, /assignment_brief/);
    assert.match(text, /get_rubric/);
    assert.match(text, /paste/i);
    assert.match(text, /do not rewrite/i);
  } finally { await close(); }
});

test('weekly_review and feedback_review start from recent feedback', async () => {
  const { client, close } = await connect();
  try {
    const week = await said(client, 'weekly_review', {});
    assert.match(week, /recent_feedback/);
    assert.match(week, /get_week_ahead/);
    assert.match(week, /one thing/i);
    const fb = await said(client, 'feedback_review', { course: 'Chemistry' });
    assert.match(fb, /Chemistry/);
    assert.match(fb, /recent_feedback/);
    assert.match(fb, /keeps coming up/i);
  } finally { await close(); }
});
