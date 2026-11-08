// A tool call that the app gives up on, or that runs far too long, stops asking Canvas for more. A call that changes
// Canvas always finishes, so a submission never stops half way. Fake Canvas that answers slowly; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, sample, tokenIn } from './fake-canvas.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake Canvas that takes `ms` to answer each request, and notes each one when it finishes. */
const slow = (ms, seen) => (base) => async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const entry = { method, path: new URL(url).pathname.replace(/^\/api\/v1/, ''), done: false };
  seen.push(entry);
  await sleep(ms);
  entry.done = true;
  entry.cutOff = Boolean(opts.signal?.aborted);
  return base(url, opts);
};

test('a read the app cancels stops asking Canvas', { timeout: 30000 }, async () => {
  const whole = [];
  const full = await connect({ wrapFetch: slow(80, whole) });
  try { await full.client.callTool({ name: 'get_all_unread', arguments: {} }); } finally { await full.close(); }
  assert.ok(whole.length >= 5, `the whole run asks Canvas ${whole.length} times`);

  const seen = [];
  const s = await connect({ wrapFetch: slow(80, seen) });
  try {
    const stop = new AbortController();
    const call = s.client.callTool({ name: 'get_all_unread', arguments: {} }, undefined, { signal: stop.signal });
    await sleep(120);
    stop.abort();
    await assert.rejects(call);
    await sleep(whole.length * 80 + 300);
    assert.ok(seen.length <= 3, `${seen.length} of ${whole.length} requests were sent after cancelling`);
  } finally { await s.close(); }
});

test('a read that runs too long is stopped, and says so', { timeout: 30000 }, async () => {
  const seen = [];
  const s = await connect({ wrapFetch: slow(80, seen), serverOptions: { toolTimeoutMs: 150 } });
  try {
    const started = Date.now();
    const r = await s.client.callTool({ name: 'get_all_unread', arguments: {} });
    assert.ok(Date.now() - started < 1500, 'the answer comes back at the ceiling, not when the work ends');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /stopped/i);
    const count = seen.length;
    await sleep(600);
    assert.ok(seen.length <= count + 1, 'nothing new is asked of Canvas after that');
  } finally { await s.close(); }
});

test('a change to Canvas finishes even if the app stops waiting', { timeout: 30000 }, async () => {
  const seen = [];
  const annotation = { ...sample('1'), annotatable_attachment_id: '5', submission_types: ['student_annotation'] };
  const s = await connect({
    wrapFetch: slow(100, seen),
    override: (method, p) => (method === 'GET' && /^\/courses\/1\/assignments\/1$/.test(p) ? { body: annotation } : undefined),
    serverOptions: { toolTimeoutMs: 120 },
  });
  try {
    const args = { course_id: '1', assignment_id: '1' };
    const preview = await s.client.callTool({ name: 'submit_annotation_assignment', arguments: args });
    const token = tokenIn(preview);
    assert.ok(token, preview.content[0].text);
    const stop = new AbortController();
    const call = s.client.callTool({ name: 'submit_annotation_assignment', arguments: { ...args, confirm: true, confirm_token: token } }, undefined, { signal: stop.signal });
    await sleep(60);
    stop.abort();
    await assert.rejects(call);
    await sleep(1200);
    const posts = seen.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 1, 'the submission was still sent');
    assert.ok(posts[0].done && !posts[0].cutOff, 'and it was never cut off part way');
  } finally { await s.close(); }
});
