// Tool profiles: CANVAS_PROFILE picks a named set of tools, by name or number. The lists live once, as data, in
// core/profiles.js. These tests hold every profile to what the docs promise, and make sure a value nobody can read
// never serves more than the safe choice. No network and no real token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './fake-canvas.js';
import { PROFILES, resolveProfile } from '../../core/profiles.js';

const text = (r) => (r.content || []).map((c) => c.text || '').join('\n');

// How many tools each profile turns on. Changing one means re-making the profile tables in the READMEs and websites.
const COUNTS = { essentials: 24, core: 49, study: 38, grades: 31, readonly: 177, full: 242 };

// The core profile as 1.3.0 shipped it, written out again so it can never drift.
const CORE = [
  'whoami', 'test_connection', 'check_token_expiry', 'raw_canvas_request', 'get_server_config',
  'list_courses', 'get_course', 'get_syllabus', 'list_assignments', 'get_assignment', 'assignment_brief',
  'list_missing_submissions', 'list_upcoming_assignments', 'list_overdue_assignments',
  'get_my_submission', 'list_submission_comments', 'submit_assignment_text', 'submit_assignment_file',
  'get_all_grades', 'get_course_grade_breakdown', 'what_if_grade', 'compute_needed_score', 'final_grade_scenarios',
  'list_conversations', 'get_conversation', 'send_message', 'reply_to_conversation',
  'list_topics', 'get_full_topic_view', 'post_entry', 'list_announcements',
  'list_calendar_events', 'list_modules', 'list_module_items', 'list_course_files', 'read_course_file',
  'get_media_captions', 'list_pages', 'get_page_content',
  'get_week_ahead', 'daily_briefing', 'get_all_unread', 'course_health_check', 'semester_snapshot', 'study_priority_ranking',
  'list_planner_items', 'create_planner_note', 'mark_planner_item_done', 'search_tools',
];

/** A server on the fake Canvas with these settings: the tools it registered, and its own report of its settings. */
async function serverWith(env = {}) {
  const s = await connect({ env });
  const config = JSON.parse(text(await s.client.callTool({ name: 'get_server_config', arguments: {} })));
  return { ...s, config, names: s.built.registry.map((t) => t.name), writes: s.built.registry.filter((t) => t.write).map((t) => t.name) };
}

async function namesWith(env) {
  const s = await serverWith(env);
  await s.close();
  return s;
}

test('the profile numbers and names never change once released', () => {
  assert.deepEqual(PROFILES.map((p) => [p.number, p.id]), [[1, 'essentials'], [2, 'core'], [3, 'study'], [4, 'grades'], [5, 'readonly'], [6, 'full']]);
  for (const p of PROFILES) {
    assert.match(p.id, /^[a-z]+$/, p.id);
    assert.ok(p.title && p.summary, `${p.id} needs a title and a one-line summary`);
    assert.equal(typeof p.writes, 'boolean', p.id);
    if (Array.isArray(p.tools)) assert.equal(new Set(p.tools).size, p.tools.length, `${p.id} lists a tool twice`);
    else assert.equal(p.tools, 'all', p.id);
  }
});

test('every tool a profile names is a real tool', async () => {
  const { names } = await namesWith({});
  for (const p of PROFILES) {
    if (Array.isArray(p.tools)) for (const n of p.tools) assert.ok(names.includes(n), `${p.id} names ${n}, which the server doesn't have`);
  }
});

test('every profile keeps the tools that find other tools and diagnose problems', () => {
  for (const p of PROFILES) {
    if (Array.isArray(p.tools)) for (const n of ['search_tools', 'test_connection', 'get_server_config']) assert.ok(p.tools.includes(n), `${p.id} must include ${n}`);
  }
});

test('each profile turns on exactly the tools the docs count', async () => {
  for (const p of PROFILES) {
    const s = await namesWith({ CANVAS_PROFILE: p.id });
    assert.equal(s.names.length, COUNTS[p.id], `${p.id} registers ${s.names.length}`);
    assert.equal(s.config.settings_problem, undefined, p.id);
  }
});

test('the core profile is exactly the 49 tools it always was', async () => {
  const s = await namesWith({ CANVAS_PROFILE: 'core' });
  assert.deepEqual([...s.names].sort(), [...CORE].sort());
  assert.deepEqual([...PROFILES.find((p) => p.id === 'core').tools].sort(), [...CORE].sort());
});

test('the small profiles stay small enough for apps with tool limits', () => {
  const size = (id) => PROFILES.find((p) => p.id === id).tools.length;
  assert.ok(size('essentials') <= 25, `essentials has ${size('essentials')}`);
  for (const id of ['study', 'grades']) assert.ok(size(id) <= 40, `${id} has ${size(id)}`);
});

test('the read-only profiles turn every change off, even when CANVAS_ALLOW_WRITES says yes', async () => {
  for (const id of ['essentials', 'readonly']) {
    const s = await serverWith({ CANVAS_PROFILE: id, CANVAS_ALLOW_WRITES: 'true' });
    try {
      assert.deepEqual(s.writes, [], `${id} must not register a write tool`);
      assert.equal(s.config.writes_enabled, false, id);
    } finally { await s.close(); }
  }
  const calls = [];
  const { client, close } = await connect({ env: { CANVAS_PROFILE: 'readonly', CANVAS_ALLOW_WRITES: 'true' }, calls });
  try {
    const r = await client.callTool({ name: 'raw_canvas_request', arguments: { method: 'POST', path: '/users/self/favorites/courses/1' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /profile/i);
    assert.deepEqual(calls.filter((c) => c.method !== 'GET'), [], 'nothing may be sent');
  } finally { await close(); }
});

test('a profile can be picked by name or number, in any case, with stray spaces', async () => {
  const want = (await namesWith({ CANVAS_PROFILE: 'study' })).names;
  for (const v of ['3', ' 3 ', 'STUDY', ' Study ']) assert.deepEqual((await namesWith({ CANVAS_PROFILE: v })).names, want, JSON.stringify(v));
  for (const p of PROFILES) {
    assert.equal(resolveProfile(String(p.number)).id, p.id);
    assert.equal(resolveProfile(p.id.toUpperCase()).id, p.id);
  }
  for (const v of [undefined, '', '  ', '${user_config.profile}']) assert.equal(resolveProfile(v).id, 'full', JSON.stringify(v));
});

test('a profile nobody can read means the smaller set, and every Canvas tool says what to fix', async () => {
  for (const v of ['02', '2.0', 'study,grades', '7', '0', '-1', 'everything', 'study grades']) {
    assert.equal(resolveProfile(v), null, v);
    const s = await serverWith({ CANVAS_PROFILE: v });
    try {
      assert.equal(s.names.length, 49, `${v} must not serve more than core`);
      assert.match(s.config.settings_problem, /CANVAS_PROFILE/, v);
      assert.match(s.config.settings_problem, /essentials/, 'the message lists the choices');
      const r = await s.client.callTool({ name: 'whoami', arguments: {} });
      assert.equal(r.isError, true, v);
      assert.match(text(r), /CANVAS_PROFILE/);
    } finally { await s.close(); }
  }
});

test('CANVAS_TOOLS and CANVAS_DISABLE_TOOLS narrow a profile and never add to it', async () => {
  const study = await namesWith({ CANVAS_PROFILE: 'study' });
  const all = await serverWith({});
  const plannerTools = all.built.registry.filter((t) => t.group === 'planner').map((t) => t.name);
  await all.close();
  const always = ['search_tools', 'test_connection', 'get_server_config'];
  const only = await namesWith({ CANVAS_PROFILE: 'study', CANVAS_TOOLS: 'planner' });
  assert.deepEqual([...only.names].sort(), study.names.filter((n) => plannerTools.includes(n) || always.includes(n)).sort());
  assert.ok(only.names.length < plannerTools.length + always.length, 'planner tools outside study stay off');
  const without = await namesWith({ CANVAS_PROFILE: 'study', CANVAS_DISABLE_TOOLS: 'planner' });
  assert.deepEqual([...without.names].sort(), study.names.filter((n) => !plannerTools.includes(n)).sort());
});

// ---------------------------------------------------------------------------------------------------------------
// The server tells the AI which profile is on, what it leaves out and how to switch
// ---------------------------------------------------------------------------------------------------------------

test('search_tools says which profile is on and finds tools the profile switched off', async () => {
  const { client, close } = await connect({ env: { CANVAS_PROFILE: 'study' } });
  try {
    const r = JSON.parse(text(await client.callTool({ name: 'search_tools', arguments: { query: 'message' } })));
    assert.deepEqual(r.profile, { id: 'study', number: 3, title: 'Study and planning' });
    const send = r.switched_off.find((t) => t.name === 'send_message');
    assert.ok(send, 'send_message is switched off in study');
    assert.equal(send.why, 'profile');
    assert.deepEqual(send.in_profiles, ['core', 'full']);
    assert.match(r.how_to_switch, /CANVAS_PROFILE/);
    assert.match(r.how_to_switch, /restart/i);
    for (const t of r.tools) assert.ok(t.in_profiles.includes('study') && t.in_profiles.includes('full'), t.name);
    const all = JSON.parse(text(await client.callTool({ name: 'search_tools', arguments: {} })));
    assert.equal(all.switched_off, undefined, 'a search for everything lists only what is on');
  } finally { await close(); }
});

test('get_server_config lists every profile with its tool count and says how to switch', async () => {
  const s = await serverWith({ CANVAS_PROFILE: 'grades' });
  await s.close();
  assert.equal(s.config.profile, 'grades', 'profile stays a plain name for anything that reads it');
  assert.equal(s.config.profile_number, 4);
  assert.equal(s.config.profile_title, 'Grades and feedback');
  assert.equal(s.config.tools_left_out_by_profile, COUNTS.full - COUNTS.grades);
  assert.deepEqual(s.config.profiles.map((p) => [p.number, p.id, p.tools]), PROFILES.map((p) => [p.number, p.id, COUNTS[p.id]]));
  assert.match(s.config.how_to_switch, /CANVAS_PROFILE/);
  assert.equal(s.config.writes_off_because, undefined);
  const ro = await namesWith({ CANVAS_PROFILE: 'readonly' });
  assert.equal(ro.config.writes_enabled, false);
  assert.match(ro.config.writes_off_because, /Read only/);
  const off = await namesWith({ CANVAS_ALLOW_WRITES: 'false' });
  assert.match(off.config.writes_off_because, /CANVAS_ALLOW_WRITES/);
});

test('test_connection reports the profile too', async () => {
  const { client, close } = await connect({ env: { CANVAS_PROFILE: '1' } });
  try {
    const said = text(await client.callTool({ name: 'test_connection', arguments: {} }));
    const r = JSON.parse(said.slice(said.indexOf('{'))); // after the made-up token's "expires soon" heads-up
    assert.equal(r.profile, 'essentials');
    assert.equal(r.profile_number, 1);
    assert.equal(r.profile_title, 'Essentials');
  } finally { await close(); }
});

test('the instructions name a smaller profile in one short sentence, and stay short', async () => {
  for (const [env, want] of [[{ CANVAS_PROFILE: 'study' }, new RegExp(`Study and planning.*${COUNTS.study} tools.*search_tools`)], [{ CANVAS_PROFILE: 'readonly' }, new RegExp(`Read only.*${COUNTS.readonly} tools`)]]) {
    const { client, close } = await connect({ env });
    try {
      const said = client.getInstructions();
      assert.match(said, want);
      assert.ok(said.length < 2000, `${said.length} characters; one app is reported to cut instructions at about 2 KB`);
    } finally { await close(); }
  }
  const { client, close } = await connect({});
  try { assert.doesNotMatch(client.getInstructions(), /profile/i); } finally { await close(); }
});

/** Every argument a prompt takes, filled with a made-up value. */
const promptArgs = (p) => Object.fromEntries((p.arguments || []).map((a) => [a.name, 'Biology']));

test('every tool a prompt tells the AI to use is in that prompt\'s needs', async () => {
  const { client, built, close } = await connect({});
  try {
    const tools = built.registry.map((t) => t.name);
    const needs = new Map(built.prompts.map((p) => [p.name, p.needs]));
    for (const p of (await client.listPrompts()).prompts) {
      const said = (await client.getPrompt({ name: p.name, arguments: promptArgs(p) })).messages.map((m) => m.content.text).join('\n');
      const named = tools.filter((n) => new RegExp(`(?<![a-z_])${n}(?![a-z_])`).test(said));
      for (const n of named) assert.ok(needs.get(p.name).includes(n), `${p.name} names ${n} but doesn't list it in needs`);
      for (const n of needs.get(p.name)) assert.ok(tools.includes(n), `${p.name} needs ${n}, which isn't a tool`);
    }
  } finally { await close(); }
});

test('a prompt only shows up when every tool it names is on', async () => {
  for (const id of ['essentials', 'core', 'readonly']) {
    const { client, built, close } = await connect({ env: { CANVAS_PROFILE: id } });
    try {
      const on = new Set(built.registry.map((t) => t.name));
      for (const p of (await client.listPrompts()).prompts) {
        const needs = built.prompts.find((x) => x.name === p.name).needs;
        for (const n of needs) assert.ok(on.has(n), `${id}: ${p.name} needs ${n}, which is off`);
      }
    } finally { await close(); }
  }
  const { client, close } = await connect({ env: { CANVAS_PROFILE: 'readonly' } });
  try {
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    assert.ok(!names.includes('email_professor'), 'a read-only profile has no prompt that sends a message');
    assert.ok(names.includes('grade_check'));
  } finally { await close(); }
});

test('CANVAS_ALLOW_WRITES=false takes the write tools out of every profile', async () => {
  for (const p of PROFILES) {
    const s = await namesWith({ CANVAS_PROFILE: p.id, CANVAS_ALLOW_WRITES: 'false' });
    assert.deepEqual(s.writes, [], p.id);
    assert.equal(s.config.settings_problem, undefined, p.id);
  }
});
