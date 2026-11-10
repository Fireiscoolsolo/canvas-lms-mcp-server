// What must never happen, whatever a tool is asked to do. Text in Canvas can reach the model, so every check here
// assumes the arguments were chosen by someone hostile. No network and no real token.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect, confirmed, tokenIn, sampleArgs, BASE } from './fake-canvas.js';

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
      const r = await confirmed(client, 'upload_to_my_files', { file_path: file });
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
    assert.equal(r.tools, 239);
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
  for (const v of [undefined, 'full', ' FULL ', '${user_config.profile}']) assert.equal((await toolsWith(v === undefined ? {} : { CANVAS_PROFILE: v })).tools, 239, JSON.stringify(v));
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

// ---------------------------------------------------------------------------------------------------------------
// Confirmation. The model can set any argument, so nothing it sends may stand in for a person saying yes.
// ---------------------------------------------------------------------------------------------------------------

const MESSAGE = { recipients: ['5'], subject: 'Lab 4', body: 'Could I have an extension?' };
const sent = (calls, p = '/conversations') => calls.filter((c) => c.method === 'POST' && c.path === p).length;

test('confirm=true never skips the question when the app can ask', async () => {
  for (const [answer, expected] of [[{ action: 'decline' }, 0], [{ action: 'accept', content: { confirm: true } }, 1]]) {
    const calls = [];
    let asked = 0;
    const { client, close } = await connect({ calls, clientCapabilities: { elicitation: {} }, onElicit: () => { asked++; return answer; } });
    try {
      await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true } });
      assert.equal(asked, 1, 'the person was asked');
      assert.equal(sent(calls), expected);
    } finally {
      await close();
    }
  }
});

test('a made-up token does not skip the question either', async () => {
  const calls = [];
  const { client, close } = await connect({ calls, clientCapabilities: { elicitation: {} }, onElicit: () => ({ action: 'decline' }) });
  try {
    await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true, confirm_token: 'made-up' } });
    assert.equal(sent(calls), 0);
  } finally {
    await close();
  }
});

test('confirm=true alone does nothing when the app cannot ask', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    const r = await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true } });
    assert.match(text(r), /DRY RUN/);
    assert.ok(tokenIn(r), 'the preview hands back a token');
    assert.equal(sent(calls), 0);
  } finally {
    await close();
  }
});

test('a token works once, for that exact request', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    const token = tokenIn(await client.callTool({ name: 'send_message', arguments: MESSAGE }));
    const swapped = await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, body: 'Something else', confirm: true, confirm_token: token } });
    assert.equal(sent(calls), 0, 'a changed message is not sent');
    assert.match(text(swapped), /nothing was sent/i);
    const otherTool = await client.callTool({ name: 'reply_to_conversation', arguments: { conversation_id: '1', body: 'x', confirm: true, confirm_token: token } });
    assert.equal(sent(calls, '/conversations/1/add_message'), 0, 'it does not work on another tool');
    assert.match(text(otherTool), /nothing was sent/i);
    const wrong = await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true, confirm_token: 'x'.repeat(22) } });
    assert.equal(sent(calls), 0, 'a wrong token does nothing');
    assert.match(text(wrong), /nothing was sent/i);
    await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true, confirm_token: token } });
    assert.equal(sent(calls), 0, 'a newer preview replaces the older token');
    const latest = tokenIn(await client.callTool({ name: 'send_message', arguments: MESSAGE }));
    await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true, confirm_token: latest } });
    assert.equal(sent(calls), 1, 'the latest token works');
    await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true, confirm_token: latest } });
    assert.equal(sent(calls), 1, 'and only once');
  } finally {
    await close();
  }
});

test('a token expires after five minutes', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  const realNow = Date.now;
  try {
    const token = tokenIn(await client.callTool({ name: 'send_message', arguments: MESSAGE }));
    Date.now = () => realNow() + 5 * 60000 + 1000;
    await client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true, confirm_token: token } });
    assert.equal(sent(calls), 0);
  } finally {
    Date.now = realNow;
    await close();
  }
});

test('two requests racing with one token send one message', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    const token = tokenIn(await client.callTool({ name: 'send_message', arguments: MESSAGE }));
    const go = () => client.callTool({ name: 'send_message', arguments: { ...MESSAGE, confirm: true, confirm_token: token } });
    await Promise.all([go(), go(), go()]);
    assert.equal(sent(calls), 1);
  } finally {
    await close();
  }
});

test('a submission is refused if the assignment changed after the preview', async () => {
  const args = { course_id: '1', assignment_id: '1', body: '<p>My essay</p>' };
  for (const change of [{ attempt: 1, submitted_at: '2026-11-01T00:00:00Z' }, { due_at: '2026-12-01T00:00:00Z' }]) {
    const calls = [];
    let state = { attempt: 0, submitted_at: null, due_at: '2026-11-20T00:00:00Z' };
    const override = (method, p) => (method === 'GET' && p === '/courses/1/assignments/1'
      ? { body: { id: '1', name: 'Essay', due_at: state.due_at, points_possible: 10, submission_types: ['online_text_entry'], submission: { attempt: state.attempt, submitted_at: state.submitted_at } } } : null);
    const { client, close } = await connect({ calls, override });
    try {
      const token = tokenIn(await client.callTool({ name: 'submit_assignment_text', arguments: args }));
      state = { ...state, ...change };
      const r = await client.callTool({ name: 'submit_assignment_text', arguments: { ...args, confirm: true, confirm_token: token } });
      assert.equal(sent(calls, '/courses/1/assignments/1/submissions'), 0, `must not submit after ${JSON.stringify(change)}`);
      assert.match(text(r), /changed/);
      assert.ok(tokenIn(r), 'the new details come with a new token');
    } finally {
      await close();
    }
  }
});

test('a file submission is refused if the file changed after the preview, even at the same size', async () => {
  const calls = [];
  const { client, dir, close } = await connect({ calls, override: uploadHandshake });
  try {
    const file = path.join(dir, 'essay.txt');
    fs.writeFileSync(file, 'first draft');
    const args = { course_id: '1', assignment_id: '1', file_path: file };
    const token = tokenIn(await client.callTool({ name: 'submit_assignment_file', arguments: args }));
    fs.writeFileSync(file, 'other draft');
    const r = await client.callTool({ name: 'submit_assignment_file', arguments: { ...args, confirm: true, confirm_token: token } });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(text(r), /changed/);
  } finally {
    await close();
  }
});

test('a delete is refused if what it would delete changed after the preview', async () => {
  const cases = [
    ['delete_my_file', { file_id: '7' }, '/files/7', 'updated_at'], ['delete_conversation', { conversation_id: '7' }, '/conversations/7', 'last_message_at'],
    ['delete_calendar_event', { event_id: '7' }, '/calendar_events/7', 'updated_at'], ['delete_planner_note', { note_id: '7' }, '/planner_notes/7', 'updated_at'],
  ];
  for (const [name, args, target, field] of cases) {
    const calls = [];
    let stamp = '2026-11-01T00:00:00Z';
    const { client, close } = await connect({ calls, override: (method, p) => (method === 'GET' && p === target ? { body: { id: '7', title: 'x', [field]: stamp } } : null) });
    try {
      const token = tokenIn(await client.callTool({ name, arguments: args }));
      stamp = '2026-11-02T00:00:00Z';
      await client.callTool({ name, arguments: { ...args, confirm: true, confirm_token: token } });
      assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, `${name} must not delete after a change`);
    } finally {
      await close();
    }
  }
});

test('raw_canvas_request writes need the same confirmation, and reads do not', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    const args = { method: 'PUT', path: '/users/self/settings', body: { a: 1 } };
    const r = await client.callTool({ name: 'raw_canvas_request', arguments: { ...args, confirm: true } });
    assert.match(text(r), /DRY RUN/);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    await client.callTool({ name: 'raw_canvas_request', arguments: { ...args, confirm: true, confirm_token: tokenIn(r) } });
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
    const read = await client.callTool({ name: 'raw_canvas_request', arguments: { method: 'GET', path: '/users/self' } });
    assert.ok(!read.isError);
    assert.doesNotMatch(text(read), /DRY RUN/);
  } finally {
    await close();
  }
});

test('with writes off, raw_canvas_request refuses a write outright', async () => {
  const calls = [];
  const { client, close } = await connect({ calls, env: { CANVAS_ALLOW_WRITES: 'false' } });
  try {
    const r = await client.callTool({ name: 'raw_canvas_request', arguments: { method: 'POST', path: '/x', confirm: true } });
    assert.equal(r.isError, true);
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

test('no confirm-gated tool changes anything on the model\'s word alone', { timeout: 120000 }, async () => {
  const calls = [];
  const { client, built, dir, close } = await connect({ calls });
  try {
    const { tools } = await client.listTools();
    const gated = built.registry.filter((t) => t.confirm).map((t) => t.name);
    assert.ok(gated.length >= 37, `expected at least 37 gated tools, got ${gated.length}`);
    for (const name of ['upload_to_my_files', 'upload_submission_file', 'upload_comment_attachment', 'delete_planner_note', 'delete_bookmark', 'update_planner_note', 'update_calendar_event', 'rate_entry', 'export_course_archive', 'create_content_export', 'raw_canvas_request']) {
      assert.ok(gated.includes(name), `${name} should need confirmation`);
    }
    for (const t of tools.filter((x) => gated.includes(x.name))) {
      calls.length = 0;
      const extra = t.name === 'raw_canvas_request' ? { method: 'POST' } : {};
      await client.callTool({ name: t.name, arguments: { ...sampleArgs(t.inputSchema, dir), ...extra, confirm: true } });
      assert.deepEqual(calls.filter((c) => c.method !== 'GET'), [], `${t.name} must not write without a token`);
    }
  } finally {
    await close();
  }
});

test('harmless writes stay one step', async () => {
  const calls = [];
  const { client, close } = await connect({ calls });
  try {
    for (const [name, args] of [['mark_announcement_read', { course_id: '1', announcement_id: '2' }], ['star_conversation', { conversation_id: '1' }], ['add_favorite_course', { course_id: '1' }], ['create_planner_note', { title: 'Read chapter 3', todo_date: '2026-11-20' }]]) {
      calls.length = 0;
      const r = await client.callTool({ name, arguments: args });
      assert.doesNotMatch(text(r), /DRY RUN/, name);
      assert.ok(calls.some((c) => c.method !== 'GET'), `${name} runs straight away`);
    }
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
