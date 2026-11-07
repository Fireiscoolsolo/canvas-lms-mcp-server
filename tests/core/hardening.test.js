// Smaller hardening: the school address is always encrypted, archives and downloads have a size limit, file names
// can't hide what they are, and long lists say when they were cut short. Fake Canvas and temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { connect, BASE } from './fake-canvas.js';
import { normalizeBase } from '../../core/canvas-client.js';
import { readConfig } from '../../core/config.js';
import { extractFileText } from '../../core/file-text.js';
import { safeFileName } from '../../core/shared.js';

// ---------------------------------------------------------------------------------------------------------------
// F23: the token never travels unencrypted
// ---------------------------------------------------------------------------------------------------------------

test('a school address written with http:// is used with https://', () => {
  assert.equal(normalizeBase('http://school.instructure.com'), 'https://school.instructure.com');
  assert.equal(normalizeBase('HTTP://School.Instructure.com/api/v1/'), 'https://School.Instructure.com');
  assert.equal(normalizeBase('school.instructure.com'), 'https://school.instructure.com');
  assert.equal(normalizeBase('https://school.instructure.com'), 'https://school.instructure.com');
});

test('a Canvas running on this computer keeps http://, for development', () => {
  for (const base of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'http://canvas.localhost']) {
    assert.equal(normalizeBase(base), base);
  }
});

test('the change is reported, so nobody wonders why the address looks different', async () => {
  const cfg = readConfig({ CANVAS_API_TOKEN: 't', CANVAS_BASE_URL: 'http://school.instructure.com' }, { readStore: () => '' });
  assert.equal(cfg.base, 'https://school.instructure.com');
  assert.match(cfg.baseNote || '', /https/);
  const lines = [];
  const s = await connect({ env: { CANVAS_BASE_URL: 'http://canvas.example.edu' }, log: (l) => lines.push(l) });
  try {
    s.built.start();
    assert.ok(lines.some((l) => /http:\/\/.*https:\/\//.test(l)), lines.join('\n'));
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// F18: files that are far bigger than they look
// ---------------------------------------------------------------------------------------------------------------

/** A Word file whose text is `bytes` long, and which can claim a much smaller size inside, as a crafted one can. */
async function wordFile(bytes, { claim } = {}) {
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document><w:p><w:t>${'a'.repeat(bytes)}</w:t></w:p></w:document>`);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  if (claim === undefined) return buf;
  // Rewrite the uncompressed size in the local header (offset 22) and the central directory (offset 24).
  for (const [signature, offset] of [[0x04034b50, 22], [0x02014b50, 24]]) {
    for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === signature) { buf.writeUInt32LE(claim, i + offset); break; }
  }
  return buf;
}

test('an Office file that expands far past its size is refused, without expanding it all', async () => {
  const bomb = await wordFile(6e6);
  assert.ok(bomb.length < 50000, `the file itself is small: ${bomb.length} bytes`);
  const started = Date.now();
  await assert.rejects(extractFileText(bomb, { name: 'notes.docx', maxUnzipped: 1e6 }), /too big|expands/i);
  assert.ok(Date.now() - started < 3000);
  const fine = await extractFileText(await wordFile(1000), { name: 'notes.docx', maxUnzipped: 1e6 });
  assert.equal(fine.text.length, 1000);
});

test('an Office file that lies about how big its contents are is still stopped', async () => {
  const liar = await wordFile(6e6, { claim: 100 });
  await assert.rejects(extractFileText(liar, { name: 'notes.docx', maxUnzipped: 1e6 }), /too big|expands/i);
});

/** A download that sends `megabytes` 1 MB pieces, made as they're asked for, and counts how many were taken. */
function bigDownload(megabytes, { contentLength } = {}) {
  const sent = { pieces: 0 };
  const piece = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({
    pull(controller) {
      if (sent.pieces >= megabytes) { controller.close(); return; }
      sent.pieces++;
      controller.enqueue(piece);
    },
  });
  const headers = { 'content-type': 'application/octet-stream', ...(contentLength ? { 'content-length': String(contentLength) } : {}) };
  return { sent, response: () => new Response(body, { status: 200, headers }) };
}

const serving = (download) => (base) => async (url, opts) => (/\/files\/\d+\/download$/.test(new URL(url).pathname) ? download.response() : base(url, opts));

test('reading a file stops at the size limit as the bytes arrive, whatever Canvas said its size was', { timeout: 60000 }, async () => {
  const download = bigDownload(40);
  const s = await connect({ wrapFetch: serving(download) });
  try {
    const r = await s.client.callTool({ name: 'read_course_file', arguments: { file_id: '1' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /too big/i);
    assert.ok(download.sent.pieces <= 27, `${download.sent.pieces} MB were pulled before it stopped`);
  } finally { await s.close(); }
});

test('a download that says it is too big is refused before any of it is fetched', { timeout: 60000 }, async () => {
  const download = bigDownload(10, { contentLength: 10 * 1024 * 1024 });
  const s = await connect({ wrapFetch: serving(download), serverOptions: { downloadLimitBytes: 5 * 1024 * 1024 } });
  try {
    const r = await s.client.callTool({ name: 'download_file', arguments: { file_id: '1' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /too big/i);
    assert.equal(download.sent.pieces <= 1, true, `${download.sent.pieces} MB were pulled`);
  } finally { await s.close(); }
});

test('a download that runs past the limit is stopped, and leaves nothing half-written behind', { timeout: 60000 }, async () => {
  const download = bigDownload(8);
  const s = await connect({ wrapFetch: serving(download), serverOptions: { downloadLimitBytes: 5 * 1024 * 1024 } });
  try {
    const r = await s.client.callTool({ name: 'download_file', arguments: { file_id: '1' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /too big/i);
    const folder = path.join(s.dir, 'downloads');
    assert.deepEqual(fs.existsSync(folder) ? fs.readdirSync(folder) : [], [], 'no file and no partial file');
  } finally { await s.close(); }
});

test('a big download is saved whole, and the same file twice is saved once', { timeout: 60000 }, async () => {
  const first = bigDownload(12);
  const s = await connect({ wrapFetch: serving(first) });
  try {
    const one = await s.client.callTool({ name: 'download_file', arguments: { file_id: '1' } });
    assert.ok(!one.isError, one.content[0].text);
    const saved = JSON.parse(one.content[0].text).saved_to;
    assert.equal(fs.statSync(saved).size, 12 * 1024 * 1024);
    const again = bigDownload(12);
    first.response = again.response;
    const two = await s.client.callTool({ name: 'download_file', arguments: { file_id: '1' } });
    assert.equal(JSON.parse(two.content[0].text).saved_to, saved);
    assert.deepEqual(fs.readdirSync(path.dirname(saved)), [path.basename(saved)]);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// F25: file names, long answers and long lists
// ---------------------------------------------------------------------------------------------------------------

test("a file name can't hide what kind of file it is", () => {
  const name = safeFileName('Syllabus‮fdp.exe');
  assert.ok(!/[؜​-‏‪-‮⁦-⁩﻿]/.test(name), JSON.stringify(name));
  assert.match(name, /.exe$/);
  assert.equal(safeFileName('notes​.pdf'), 'notes.pdf');
});

test('names Windows keeps for devices are never used', () => {
  for (const n of ['CON', 'con.txt', 'CONIN$', 'conout$.log', 'COM¹.txt', 'LPT³', 'COM1.pdf', 'nul .txt']) assert.equal(safeFileName(n), 'download', n);
  assert.equal(safeFileName('Concert notes.pdf'), 'Concert notes.pdf');
  assert.equal(safeFileName('Computer basics.pdf'), 'Computer basics.pdf');
});

test('a long name is shortened but keeps its extension', () => {
  const n = safeFileName(`${'a'.repeat(300)}.pdf`);
  assert.ok(n.length <= 180, String(n.length));
  assert.match(n, /.pdf$/);
});

const soon = new Date(Date.now() + 86400000).toISOString();
const plannerItem = (i, title = `Assignment ${i}`) => ({ plannable_type: 'assignment', plannable_id: String(i), course_id: '1', plannable: { title, due_at: soon }, html_url: `/courses/1/assignments/${i}` });

test('a structured answer is kept within the size limit too, and says it was shortened', async () => {
  const many = Array.from({ length: 150 }, (_, i) => plannerItem(i, `Assignment ${i} ${'x'.repeat(200)}`));
  const s = await connect({ env: { CANVAS_MAX_RESPONSE_CHARS: '5000' }, override: (m, p) => (p === '/planner/items' ? { body: many } : undefined) });
  try {
    const r = await s.client.callTool({ name: 'list_upcoming_assignments', arguments: {} });
    assert.ok(!r.isError, r.content[0].text.slice(0, 300));
    assert.ok(JSON.stringify(r.structuredContent).length <= 5000, String(JSON.stringify(r.structuredContent).length));
    assert.ok(r.structuredContent.items.length > 0 && r.structuredContent.items.length < 150, String(r.structuredContent.items.length));
    assert.match(r.content[0].text, /shortened/i);
  } finally { await s.close(); }
});

const CUT = /Canvas had more than this server reads in one go/;

test("a list cut short at the server's limit says so", async () => {
  const page = Array.from({ length: 50 }, (_, i) => plannerItem(i));
  const s = await connect({ override: (m, p) => (p === '/planner/items' ? { body: page, headers: { link: `<${BASE}/api/v1/planner/items?page=2>; rel="next"` } } : undefined) });
  try {
    const r = await s.client.callTool({ name: 'list_upcoming_assignments', arguments: {} });
    assert.match(r.content[0].text, CUT);
  } finally { await s.close(); }
});

test('a complete list, or one the tool already pages, has no such note', async () => {
  const s = await connect({ override: (m, p) => (p.endsWith('/assignments') ? { body: [{ id: '1', name: 'HW' }], headers: { link: `<${BASE}/api/v1/courses/1/assignments?page=2>; rel="next"` } } : undefined) });
  try {
    const whole = await s.client.callTool({ name: 'list_upcoming_assignments', arguments: {} });
    assert.doesNotMatch(whole.content[0].text, CUT);
    const paged = await s.client.callTool({ name: 'list_assignments', arguments: { course_id: '1' } });
    assert.doesNotMatch(paged.content[0].text, CUT);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// The activity stream fits in one answer
// ---------------------------------------------------------------------------------------------------------------

test('the activity stream keeps what matters and leaves out the whole assignment and course', async () => {
  const big = 'x'.repeat(3000);
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: String(i), type: 'Submission', title: `Grade for HW ${i}`, message: '<p>Graded</p>', created_at: soon, html_url: `/courses/1/assignments/${i}/submissions/9`,
    course_id: '1', context_type: 'Course', score: 9, grade: 'A-', read_state: false,
    assignment: { id: String(i), description: big, rubric: [{ description: big }] }, course: { id: '1', syllabus_body: big }, user: { id: '9', name: 'Alex Example', bio: big },
  }));
  const s = await connect({ override: (m, p) => (p === '/users/self/activity_stream' ? { body: items } : undefined) });
  try {
    const r = await s.client.callTool({ name: 'get_activity_stream', arguments: {} });
    const text = r.content[0].text;
    assert.ok(text.length < 60000, `${text.length} characters`);
    assert.doesNotMatch(text, /"assignment"|"course"|"user"/);
    assert.match(text, /Grade for HW 49/);
    assert.match(text, /"score": 9/);
    assert.match(text, /Graded/);
  } finally { await s.close(); }
});
