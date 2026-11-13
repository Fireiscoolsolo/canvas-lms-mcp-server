// The change log: a file on this computer listing what the server changed in Canvas, so a student can check what
// their AI did. It keeps IDs only, never message text, file paths or anything Canvas sent back. Fake Canvas only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, tokenIn } from './fake-canvas.js';
import { createChangeLog, changeLogSetting, CHANGE_LOG_FILE, OLD_CHANGE_LOG_FILE } from '../../core/change-log.js';

const text = (r) => (r.content || []).map((c) => c.text || '').join('\n');
const answer = (r) => { const t = text(r); return JSON.parse(t.slice(t.indexOf('{'))); };
const logOf = (dir) => {
  const file = path.join(dir, 'state', CHANGE_LOG_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const SECRET = 'My whole essay about photosynthesis';

test('a submission is recorded with its IDs and none of its text', async () => {
  const { client, dir, close } = await connect({ clientCapabilities: { elicitation: {} }, onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
  try {
    await client.callTool({ name: 'submit_assignment_text', arguments: { course_id: '1', assignment_id: '2', body: SECRET, comment: 'please grade' } });
    const raw = fs.readFileSync(path.join(dir, 'state', CHANGE_LOG_FILE), 'utf8');
    assert.ok(!raw.includes(SECRET) && !raw.includes('please grade'), 'no text the student wrote');
    assert.ok(!raw.includes('test-token'), 'no token');
    const [entry] = logOf(dir);
    assert.equal(entry.tool, 'submit_assignment_text');
    assert.equal(entry.outcome, 'done');
    assert.equal(entry.confirmed_by, 'asked in the app');
    assert.deepEqual(entry.ids, { course_id: '1', assignment_id: '2' });
    assert.ok(!Number.isNaN(Date.parse(entry.at)));
  } finally { await close(); }
});

test('a declined confirmation is recorded as cancelled, and a preview alone is not recorded', async () => {
  const no = await connect({ clientCapabilities: { elicitation: {} }, onElicit: () => ({ action: 'decline' }) });
  try {
    await no.client.callTool({ name: 'send_message', arguments: { recipients: ['5'], subject: 'Hi', body: SECRET } });
    assert.deepEqual(logOf(no.dir).map((e) => [e.tool, e.outcome]), [['send_message', 'cancelled']]);
  } finally { await no.close(); }

  const { client, dir, close } = await connect({ elicitation: false });
  try {
    const args = { course_id: '1', topic_id: '3', message: SECRET };
    const preview = await client.callTool({ name: 'post_entry', arguments: args });
    assert.deepEqual(logOf(dir), [], 'nothing happened yet');
    await client.callTool({ name: 'post_entry', arguments: { ...args, confirm: true, confirm_token: tokenIn(preview) } });
    await client.callTool({ name: 'post_entry', arguments: { ...args, confirm: true, confirm_token: 'made-up' } });
    assert.deepEqual(logOf(dir).map((e) => [e.outcome, e.confirmed_by]), [['done', 'preview and one-time token'], ['refused', 'preview and one-time token']]);
  } finally { await close(); }
});

test('a change that needs no confirmation is recorded too, and a bad ID is recorded as refused without the bad value', async () => {
  const { client, dir, close } = await connect();
  try {
    await client.callTool({ name: 'mark_topic_read', arguments: { course_id: '1', topic_id: '3' } });
    await client.callTool({ name: 'mark_topic_read', arguments: { course_id: '1', topic_id: '../../users/self' } });
    const [ok, bad] = logOf(dir);
    assert.deepEqual([ok.outcome, ok.confirmed_by], ['done', 'not needed']);
    assert.equal(bad.outcome, 'refused');
    assert.equal(bad.ids.topic_id, '[not an ID]');
    await client.callTool({ name: 'list_courses', arguments: {} });
    assert.equal(logOf(dir).length, 2, 'reading is never recorded');
  } finally { await close(); }
});

test('get_change_log lists changes newest first and works before a token is set', async () => {
  const { client, close } = await connect({ clientCapabilities: { elicitation: {} }, onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
  try {
    await client.callTool({ name: 'mark_topic_read', arguments: { course_id: '1', topic_id: '3' } });
    await client.callTool({ name: 'send_message', arguments: { recipients: ['5'], subject: 'Hi', body: SECRET } });
    const r = answer(await client.callTool({ name: 'get_change_log', arguments: {} }));
    assert.equal(r.recording, true);
    assert.deepEqual(r.changes.map((c) => c.tool), ['send_message', 'mark_topic_read']);
    assert.ok(r.changes[0].when, 'a readable time');
  } finally { await close(); }
  const empty = await connect({ env: { CANVAS_API_TOKEN: '' } });
  try {
    const r = await empty.client.callTool({ name: 'get_change_log', arguments: {} });
    assert.ok(!r.isError, text(r));
  } finally { await empty.close(); }
});

test('CANVAS_CHANGE_LOG=off writes nothing, and a value nobody can read leaves it on', async () => {
  for (const v of ['off', 'OFF', 'false', '0', 'no']) {
    assert.equal(changeLogSetting({ CANVAS_CHANGE_LOG: v }).on, false, v);
    const { client, dir, close } = await connect({ env: { CANVAS_CHANGE_LOG: v } });
    try {
      await client.callTool({ name: 'mark_topic_read', arguments: { course_id: '1', topic_id: '3' } });
      assert.ok(!fs.existsSync(path.join(dir, 'state', CHANGE_LOG_FILE)), v);
      assert.equal(answer(await client.callTool({ name: 'get_change_log', arguments: {} })).recording, false);
    } finally { await close(); }
  }
  for (const v of [undefined, '', 'on', 'true', '1', 'yes']) assert.deepEqual(changeLogSetting(v === undefined ? {} : { CANVAS_CHANGE_LOG: v }), { on: true, problem: '' }, v);
  const odd = changeLogSetting({ CANVAS_CHANGE_LOG: 'sometimes' });
  assert.equal(odd.on, true, 'this setting doesn\'t restrict the server, so an unreadable value keeps the safer record');
  assert.match(odd.problem, /CANVAS_CHANGE_LOG/);
});

test('the file never grows past the limit plus one entry, and one old copy is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-changes-'));
  try {
    const log = createChangeLog({ dir, limitBytes: 600 });
    let longest = 0;
    for (let i = 0; i < 60; i++) {
      log.record({ tool: 'mark_topic_read', outcome: 'done', confirmed_by: 'not needed', args: { course_id: String(i), topic_id: '3' } });
      longest = Math.max(longest, fs.statSync(path.join(dir, CHANGE_LOG_FILE)).size);
    }
    assert.ok(longest <= 600 + 200, `${longest} bytes`);
    assert.ok(fs.existsSync(path.join(dir, OLD_CHANGE_LOG_FILE)));
    assert.equal(log.read(5)[0].ids.course_id, '59', 'newest first, across both files');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, CHANGE_LOG_FILE)).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without a state folder it remembers this run only', () => {
  const log = createChangeLog({ dir: null });
  log.record({ tool: 'send_message', outcome: 'done', confirmed_by: 'asked in the app', args: { recipients: ['5'] } });
  assert.deepEqual(log.read(10).map((e) => e.tool), ['send_message']);
  assert.equal(log.file, null);
});

test('the change log can never be uploaded to Canvas', async () => {
  const calls = [];
  const { client, dir, close } = await connect({ calls });
  try {
    for (const name of [CHANGE_LOG_FILE, OLD_CHANGE_LOG_FILE]) {
      const file = path.join(dir, 'elsewhere', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}\n');
      const r = await client.callTool({ name: 'upload_to_my_files', arguments: { file_path: file } });
      assert.equal(r.isError, true, name);
      assert.match(text(r), /private file/);
    }
    assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing was sent');
  } finally { await close(); }
});
