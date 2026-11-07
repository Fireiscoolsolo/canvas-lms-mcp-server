// What must never happen, whatever a tool is asked to do. Text in Canvas can reach the model, so every check here
// assumes the arguments were chosen by someone hostile. No network and no real token.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect, BASE } from './fake-canvas.js';

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
