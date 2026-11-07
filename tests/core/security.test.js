// What must never happen, whatever a tool is asked to do. Text in Canvas can reach the model, so every check here
// assumes the arguments were chosen by someone hostile. No network and no real token.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect, sampleArgs, BASE } from './fake-canvas.js';

const CANVAS_HOST = new URL(BASE).host;
const text = (r) => (r.content || []).map((c) => c.text || '').join('\n');
const offCanvas = (calls) => calls.filter((c) => new URL(c.url).host !== CANVAS_HOST);
const withToken = (calls) => calls.filter((c) => c.auth);

// ---------------------------------------------------------------------------------------------------------------
// The token only goes to Canvas
// ---------------------------------------------------------------------------------------------------------------

test('a full address outside Canvas is refused, in any spelling, and the token never leaves', async () => {
  const hostile = [
    'https://evil.example/x', 'http://evil.example/x', 'HTTPS://evil.example/x', 'hTtP://evil.example/x',
    `https://${CANVAS_HOST}@evil.example/x`, `https://${CANVAS_HOST}.evil.example/x`, `http://${CANVAS_HOST}/api/v1/users/self`,
  ];
  for (const p of hostile) {
    const calls = [];
    const { client, close } = await connect({ calls });
    try {
      const r = await client.callTool({ name: 'raw_canvas_request', arguments: { method: 'GET', path: p } });
      assert.equal(r.isError, true, `${p} should be refused`);
      assert.match(text(r), /Refused/);
      assert.deepEqual(calls, [], `${p} must not be requested at all`);
    } finally {
      await close();
    }
  }
});

test('spellings that only look like another host stay on Canvas', async () => {
  for (const p of ['//evil.example/x', '@evil.example/x', '/@evil.example/x', 'http:/evil.example/x', 'http:evil.example/x', 'ftp://evil.example/x']) {
    const calls = [];
    const { client, close } = await connect({ calls });
    try {
      await client.callTool({ name: 'raw_canvas_request', arguments: { method: 'GET', path: p } });
      assert.deepEqual(offCanvas(calls), [], `${p} must stay on Canvas`);
    } finally {
      await close();
    }
  }
});

test('a full Canvas address still works, because it cannot leak anything', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    const r = await client.callTool({ name: 'raw_canvas_request', arguments: { method: 'GET', path: `${BASE}/api/v1/users/self` } });
    assert.ok(!r.isError);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/users/self');
  } finally {
    await close();
  }
});

test('download_submission_attachment only fetches from Canvas', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    const r = await client.callTool({ name: 'download_submission_attachment', arguments: { url: 'https://evil.example/stolen.txt' } });
    assert.equal(r.isError, true);
    assert.deepEqual(calls, []);
    const fine = await client.callTool({ name: 'download_submission_attachment', arguments: { url: `${BASE}/files/1/download` } });
    assert.ok(!fine.isError, text(fine));
    assert.equal(withToken(calls).length, 1);
    const blocked = await client.callTool({ name: 'download_submission_attachment', arguments: { url: `${BASE}/api/v1/login/session_token` } });
    assert.equal(blocked.isError, true);
  } finally {
    await close();
  }
});

test('a next-page link that leaves Canvas is not followed', async () => {
  const calls = [];
  const override = (_m, p) => (p === '/paged' ? { body: [{ id: '1' }], headers: { link: '<https://evil.example/page2>; rel="next"' } } : null);
  const { client, close } = await connect({ calls, override });
  try {
    const r = await client.callTool({ name: 'raw_canvas_request', arguments: { method: 'GET', path: '/paged', paginate: true } });
    assert.equal(r.isError, true);
    assert.deepEqual(offCanvas(calls), []);
  } finally {
    await close();
  }
});

test('a file address from Canvas that points elsewhere is fetched without the token', async () => {
  const calls = [];
  const override = (_m, p) => {
    if (/^\/files\/7$/.test(p)) return { body: { id: '7', display_name: 'notes.txt', 'content-type': 'text/plain', size: 5, url: 'https://cdn.example.net/signed/notes.txt' } };
    if (/\/media_tracks$/.test(p)) return { body: [{ id: '1', locale: 'en', url: 'https://cdn.example.net/track.vtt' }] };
    return null;
  };
  const { client, close } = await connect({ calls, override });
  try {
    await client.callTool({ name: 'read_course_file', arguments: { file_id: '7' } });
    await client.callTool({ name: 'download_media_captions', arguments: { media_id: 'm1' } });
    const away = offCanvas(calls);
    assert.equal(away.length, 2, 'both files are fetched');
    assert.deepEqual(withToken(away), [], 'neither carries the token');
  } finally {
    await close();
  }
});

test('the upload confirm step never sends the token off Canvas, and follows a Canvas location', async () => {
  for (const [location, works] of [['https://evil.example/confirm', false], [`${BASE}/api/v1/files/55`, true]]) {
    const calls = [];
    const override = (method, p, u) => {
      if (method === 'POST' && p === '/users/self/files') return { body: { upload_url: 'https://storage.example.net/up', upload_params: {} } };
      if (method === 'POST' && u.host === 'storage.example.net') return { status: 201, body: {}, headers: { location } };
      return null;
    };
    const { client, dir, close } = await connect({ calls, override });
    try {
      const file = path.join(dir, 'notes.txt');
      fs.writeFileSync(file, 'hi');
      const r = await client.callTool({ name: 'upload_to_my_files', arguments: { file_path: file, confirm: true } });
      assert.deepEqual(withToken(offCanvas(calls)), [], 'no token off Canvas');
      assert.equal(calls.some((c) => c.url.startsWith('https://evil.example')), false, 'nothing goes to the other host');
      if (works) assert.ok(!r.isError, text(r));
    } finally {
      await close();
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Blocked Canvas endpoints stay blocked, however they are spelled and whichever tool asks
// ---------------------------------------------------------------------------------------------------------------

const QUIZ_SPELLINGS = [
  '/courses/1/quizzes/12/submissions', '/quiz_submissions/5/questions', '/courses/1/quizzes/12/submissions/5/complete',
  '/courses/1/quizzes/12/./submissions', '/courses/1/quizzes/12/x/../submissions', '/courses/1/quizzes/12\\submissions',
  '/courses/1/quizzes/12/sub\tmissions', '/courses/1/quizzes/12/sub\nmissions', '/courses/1/quizzes/12/sub\rmissions',
  '/courses/1/quizzes/./12/submissions', '/courses/1/quizzes/12//submissions', '/courses/1/quizzes/%31%32/submissions',
  '/courses/1/quizzes/12/%73ubmissions', '/courses/1/QUIZZES/12/submissions', '/courses/1/quizzes/sis_quiz_id:12/submissions',
  '/quiz%5Fsubmissions/5/complete', '/quiz_\tsubmissions/5/complete', '/courses/1/quizzes/12/submissions.json',
  '/courses/1/quizzes/12%2fsubmissions', '/courses/1/quizzes/12/%2e/submissions', '/quiz%255Fsubmissions/5/complete',
];

test('quiz-taking endpoints are refused in every spelling', async () => {
  for (const p of QUIZ_SPELLINGS) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const calls = [];
      const { client, close } = await connect({ calls });
      try {
        const r = await client.callTool({ name: 'raw_canvas_request', arguments: { method, path: p, confirm: true, body: {} } });
        assert.equal(r.isError, true, `${method} ${JSON.stringify(p)} should be refused`);
        assert.deepEqual(calls, [], `${method} ${JSON.stringify(p)} must not be sent`);
      } finally {
        await close();
      }
    }
  }
});

test('the quiz block is in the Canvas client, so no tool can get around it', async () => {
  const calls = [];
  const { built, close } = await connect({ calls });
  try {
    await assert.rejects(built.canvas.post('/courses/1/quizzes/12/submissions', {}), /Refused/);
    await assert.rejects(built.canvas.put('/quiz_submissions/5/complete', {}), /Refused/);
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

test('reading your quiz attempts still works', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    const r = await client.callTool({ name: 'list_my_quiz_submissions', arguments: { course_id: '1', quiz_id: '12' } });
    assert.ok(!r.isError, text(r));
    assert.equal(calls[0].path, '/courses/1/quizzes/12/submissions');
  } finally {
    await close();
  }
});

test('a request cannot leave the API or reach endpoints that hand out sign-ins', async () => {
  const refused = [
    ['POST', '/../graphql'], ['GET', '/../../login/session_token'], ['GET', '/login/session_token'], ['GET', '/%2e%2e/%2e%2e/login'],
    ['POST', '/users/self/tokens'], ['GET', '/users/self/tokens'], ['DELETE', '/users/5/tokens/9'], ['GET', '/users%2fself/tokens'],
    ['POST', '/users/self/communication_channels'], ['DELETE', '/users/self/communication_channels/9'],
  ];
  for (const [method, p] of refused) {
    const calls = [];
    const { client, close } = await connect({ calls });
    try {
      const r = await client.callTool({ name: 'raw_canvas_request', arguments: { method, path: p, confirm: true, body: {} } });
      assert.equal(r.isError, true, `${method} ${p} should be refused`);
      assert.deepEqual(calls, [], `${method} ${p} must not be sent`);
    } finally {
      await close();
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// An ID can only be an ID. Built from the tool list, so a new tool is covered without anyone remembering to add it.
// ---------------------------------------------------------------------------------------------------------------

const isIdParam = (name, prop) => (name === 'id' || name.endsWith('_id')) && prop.type === 'string';

test('no tool lets an ID point the request somewhere else', { timeout: 120000 }, async () => {
  const calls = [];
  const { client, dir, close } = await connect({ calls });
  try {
    const { tools } = await client.listTools();
    let checked = 0;
    for (const t of tools) {
      for (const [name, prop] of Object.entries(t.inputSchema.properties || {})) {
        if (!isIdParam(name, prop)) continue;
        for (const value of ['1/discussion_topics/5/entries?x=', '../conversations/123?x=', '1?x=', '1#x', '1%2fcanary', '1\\canary', '..', '.', '1\ncanary']) {
          calls.length = 0;
          const r = await client.callTool({ name: t.name, arguments: { ...sampleArgs(t.inputSchema, dir), [name]: value, confirm: true } });
          assert.equal(r.isError, true, `${t.name}.${name} should refuse ${JSON.stringify(value)}`);
          assert.deepEqual(calls, [], `${t.name}.${name} must send nothing for ${JSON.stringify(value)}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 1000, `expected a broad check, did ${checked}`);
  } finally {
    await close();
  }
});

test('a list of IDs is checked too', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    const r = await client.callTool({ name: 'export_all_courses', arguments: { course_ids: ['1', '2/discussion_topics/5/entries?x='], confirm: true } });
    assert.equal(r.isError, true, text(r));
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

test('real Canvas IDs still work', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    for (const id of ['123', 'self', 'sis_course_id:BIO-101', 'sis_course_id:BIO 101', '1234~5678', 'uuid:abc-123', 'hex:sis_course_id:414243', '9007199254740993']) {
      const r = await client.callTool({ name: 'get_course', arguments: { course_id: id } });
      assert.ok(!r.isError, `${id}: ${text(r)}`);
    }
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// A setting that restricts something never fails open
// ---------------------------------------------------------------------------------------------------------------

async function toolsWith(env) {
  const { built, client, close } = await connect({ env });
  const config = JSON.parse(text(await client.callTool({ name: 'get_server_config', arguments: {} })));
  const whoami = await client.callTool({ name: 'search_tools', arguments: { query: 'whoami' } });
  const canvasTool = built.registry.some((t) => t.name === 'whoami') ? await client.callTool({ name: 'whoami', arguments: {} }) : null;
  await close();
  return { tools: built.registry.length, writes: built.registry.filter((t) => t.write).length, config, whoami, canvasTool };
}

test('every spelling of "no writes" turns writes off, and every spelling of "yes" leaves them on', async () => {
  for (const v of ['false', 'FALSE', 'False', '0', 'no', 'No', 'off', ' false', 'false ']) {
    const r = await toolsWith({ CANVAS_ALLOW_WRITES: v });
    assert.equal(r.writes, 0, `${JSON.stringify(v)} must turn writes off`);
    assert.equal(r.config.settings_problem, undefined);
    assert.ok(!r.canvasTool.isError);
  }
  for (const v of [undefined, '', '   ', 'true', 'TRUE', '1', 'yes', 'on', '${user_config.allow_writes}']) {
    const r = await toolsWith(v === undefined ? {} : { CANVAS_ALLOW_WRITES: v });
    assert.equal(r.writes, 65, `${JSON.stringify(v)} must leave writes on`);
    assert.equal(r.tools, 237);
  }
});

test('a value nobody can read fails closed and says why', async () => {
  for (const v of ['flase', 'nope', '2', 'disabled']) {
    const r = await toolsWith({ CANVAS_ALLOW_WRITES: v });
    assert.equal(r.writes, 0, `${v} must not leave writes on`);
    assert.match(r.config.settings_problem, /CANVAS_ALLOW_WRITES/);
    assert.equal(r.canvasTool.isError, true);
    assert.match(text(r.canvasTool), /CANVAS_ALLOW_WRITES/);
  }
});

test('the profile setting is trimmed, and an unknown one means the smaller set', async () => {
  for (const v of ['core', 'CORE', 'Core ', ' core']) assert.equal((await toolsWith({ CANVAS_PROFILE: v })).tools, 49, JSON.stringify(v));
  for (const v of [undefined, 'full', ' FULL ', '${user_config.profile}']) assert.equal((await toolsWith(v === undefined ? {} : { CANVAS_PROFILE: v })).tools, 237, JSON.stringify(v));
  for (const v of ['cor', 'minimal']) {
    const r = await toolsWith({ CANVAS_PROFILE: v });
    assert.equal(r.tools, 49, `${v} must not serve everything`);
    assert.match(r.config.settings_problem, /CANVAS_PROFILE/);
  }
});

test('a name in the tool lists that matches nothing is reported, not silently ignored', async () => {
  const typo = await toolsWith({ CANVAS_DISABLE_TOOLS: 'raw_canvas_requests,inbox' });
  assert.deepEqual(typo.config.unknown_tool_names, ['raw_canvas_requests']);
  const fine = await toolsWith({ CANVAS_DISABLE_TOOLS: 'raw_canvas_request,inbox' });
  assert.equal(fine.config.unknown_tool_names, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// The server's disk: downloads stay in the download folder, nothing is overwritten, private files are never uploaded
// ---------------------------------------------------------------------------------------------------------------

const fileRecord = (_m, p) => (/^\/files\/1$/.test(p) ? { body: { id: '1', display_name: 'Run Me.bat', 'content-type': 'text/plain', size: 5, url: `${BASE}/files/1/download` } } : null);

test('downloads cannot leave the download folder', async () => {
  const { client, dir, close } = await connect({ override: fileRecord });
  try {
    const outside = path.join(dir, 'pretend-startup-folder');
    for (const destDir of [outside, '../pretend-startup-folder', '..', path.join(dir, 'downloads', '..', 'pretend-startup-folder')]) {
      for (const [name, args] of [['download_file', { file_id: '1' }], ['download_media_captions', { media_id: 'm1' }], ['download_all_course_files', { course_id: '1' }], ['export_course_archive', { course_id: '1', timeout_seconds: 1 }]]) {
        const r = await client.callTool({ name, arguments: { ...args, dest_dir: destDir, confirm: true } });
        assert.equal(r.isError, true, `${name} must refuse ${destDir}: ${text(r)}`);
        assert.match(text(r), /download folder/);
      }
    }
    assert.equal(fs.existsSync(outside), false);
  } finally {
    await close();
  }
});

test('a link inside the download folder cannot lead out of it', async () => {
  const { client, dir, close } = await connect({ override: fileRecord });
  try {
    const downloads = path.join(dir, 'downloads');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(downloads, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(downloads, 'link'), 'junction');
    const r = await client.callTool({ name: 'download_file', arguments: { file_id: '1', dest_dir: 'link' } });
    assert.equal(r.isError, true, text(r));
    assert.deepEqual(fs.readdirSync(outside), []);
    const deeper = await client.callTool({ name: 'download_file', arguments: { file_id: '1', dest_dir: path.join('link', 'new', 'folder') } });
    assert.equal(deeper.isError, true, text(deeper));
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    await close();
  }
});

test('a folder inside the download folder works, by name or by full path', async () => {
  const { client, dir, close } = await connect({ override: fileRecord });
  try {
    await client.callTool({ name: 'download_file', arguments: { file_id: '1', dest_dir: 'week1' } });
    await client.callTool({ name: 'download_file', arguments: { file_id: '1', dest_dir: path.join(dir, 'downloads', 'week2') } });
    assert.ok(fs.existsSync(path.join(dir, 'downloads', 'week1', 'Run Me.bat')));
    assert.ok(fs.existsSync(path.join(dir, 'downloads', 'week2', 'Run Me.bat')));
  } finally {
    await close();
  }
});

test('a relative download folder is not nested inside itself', async () => {
  const { client, dir, close } = await connect({ override: fileRecord, env: (d) => ({ CANVAS_DOWNLOAD_DIR: path.relative(process.cwd(), path.join(d, 'relative')) }) });
  try {
    await client.callTool({ name: 'download_all_course_files', arguments: { course_id: '1' } });
    assert.ok(fs.existsSync(path.join(dir, 'relative', 'BIO-101')), 'saved under the folder itself');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'relative')), ['BIO-101'], 'and not in a copy of it');
  } finally {
    await close();
  }
});

test('a download never replaces a different file, and the same file is not saved twice', async () => {
  const { client, dir, close } = await connect({ override: fileRecord });
  try {
    const folder = path.join(dir, 'downloads');
    const first = path.join(folder, 'Run Me.bat');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(first, 'my own work');
    const r = await client.callTool({ name: 'download_file', arguments: { file_id: '1' } });
    assert.equal(fs.readFileSync(first, 'utf8'), 'my own work', 'the existing file is untouched');
    assert.match(text(r), /Run Me \(1\)\.bat/);
    await client.callTool({ name: 'download_file', arguments: { file_id: '1' } });
    assert.equal(fs.existsSync(path.join(folder, 'Run Me (2).bat')), false, 'identical bytes are not saved again');
  } finally {
    await close();
  }
});

const uploadHandshake = (method, p, u) => {
  if (method === 'POST' && u.host === 'storage.example.net') return { status: 201, body: { id: '55', display_name: 'x', size: 2 } };
  if (method === 'POST' && /\/files$/.test(p)) return { body: { upload_url: 'https://storage.example.net/up', upload_params: {} } };
  return null;
};
const UPLOAD_TOOLS = [['upload_to_my_files', {}], ['upload_submission_file', { course_id: '1', assignment_id: '1' }], ['upload_comment_attachment', { course_id: '1', assignment_id: '1' }], ['submit_assignment_file', { course_id: '1', assignment_id: '1' }]];

test('private files are never uploaded, whichever tool asks', async () => {
  const calls = [];
  const { client, dir, close } = await connect({ calls, override: uploadHandshake });
  try {
    const names = ['.env', '.env.local', '.env.backup-20260101-000000', 'oauth-store.json', 'oauth-store.json.tmp', 'login-history.json', 'id_rsa', 'id_ed25519', 'server.pem', 'cert.pfx', '.npmrc', '.git-credentials', 'claude_desktop_config.json', 'ngrok.yml'];
    const folders = [['.ssh', 'notes.txt'], ['.aws', 'config'], ['AppData', 'Roaming', 'Claude', 'notes.txt'], ['AppData', 'Local', 'Google', 'Chrome', 'User Data', 'notes.txt'], ['Library', 'Application Support', 'Google', 'Chrome', 'notes.txt'], ['state', 'notes.txt']];
    const files = [...names.map((n) => path.join(dir, n)), ...folders.map((f) => path.join(dir, ...f))];
    for (const f of files) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'pretend secret');
      for (const [name, args] of UPLOAD_TOOLS) {
        calls.length = 0;
        const r = await client.callTool({ name, arguments: { ...args, file_path: f, confirm: true } });
        assert.equal(r.isError, true, `${name} must refuse ${f}: ${text(r)}`);
        assert.equal(calls.filter((c) => c.method === 'POST').length, 0, `${name} must not start an upload for ${f}`);
      }
    }
  } finally {
    await close();
  }
});

test('a link to a private file is refused too', async () => {
  const { client, dir, close } = await connect({ override: uploadHandshake });
  try {
    const secret = path.join(dir, '.env');
    const innocent = path.join(dir, 'essay.txt');
    fs.writeFileSync(secret, 'pretend secret');
    try { fs.symlinkSync(secret, innocent, 'file'); } catch { return; } // Windows needs a permission for file links
    const r = await client.callTool({ name: 'upload_to_my_files', arguments: { file_path: innocent, confirm: true } });
    assert.equal(r.isError, true);
  } finally {
    await close();
  }
});

test('ordinary schoolwork still uploads, from any folder', async () => {
  const { client, dir, close } = await connect({ override: uploadHandshake });
  try {
    for (const rel of [['Documents', 'essay.docx'], ['OneDrive', 'School', 'deck.key'], ['Desktop', 'environment.pdf'], ['Downloads', 'env-notes.txt']]) {
      const f = path.join(dir, ...rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'hi');
      const r = await client.callTool({ name: 'upload_submission_file', arguments: { course_id: '1', assignment_id: '1', file_path: f, confirm: true } });
      assert.doesNotMatch(text(r), /Refused/, rel.join('/'));
    }
  } finally {
    await close();
  }
});

test('a file in a download folder inside the settings folder can still be uploaded', async () => {
  const { client, dir, close } = await connect({ override: uploadHandshake, env: (d) => ({ CANVAS_DOWNLOAD_DIR: path.join(d, 'state', 'canvas-downloads') }) });
  try {
    const saved = path.join(dir, 'state', 'canvas-downloads', 'notes.txt');
    const settings = path.join(dir, 'state', 'notes.txt');
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, 'hi');
    fs.writeFileSync(settings, 'hi');
    const fine = await client.callTool({ name: 'upload_to_my_files', arguments: { file_path: saved, confirm: true } });
    assert.doesNotMatch(text(fine), /Refused/);
    const refused = await client.callTool({ name: 'upload_to_my_files', arguments: { file_path: settings, confirm: true } });
    assert.match(text(refused), /Refused/);
  } finally {
    await close();
  }
});

test('the endpoints this server needs are not caught by the blocks', async () => {
  const calls = [];
  const { built, close } = await connect({ calls });
  try {
    await built.canvas.get('/users/self/user_generated_tokens', null, { ttl: 0 });
    await built.canvas.get('/users/self/communication_channels', null, { ttl: 0 });
    await built.canvas.put('/users/self/communication_channels/9/notification_preference_categories/grading', {});
    await built.canvas.get('/courses/1/pages/week-1..2', null, { ttl: 0 });
    await built.canvas.get('/courses/1/files?search_term=a..b', null, { ttl: 0 });
    assert.equal(calls.length, 5);
  } finally {
    await close();
  }
});
