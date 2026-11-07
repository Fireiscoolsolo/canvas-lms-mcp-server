// A stand-in for the Canvas API: a fetch() that answers any path with plausible, made-up data (no real names,
// tokens or schools), and an in-memory MCP client connected to a server built on it. Used by the core tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCanvasServer } from '../../core/index.js';

export const BASE = 'https://canvas.example.edu';
const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();

/** One made-up record with the fields many endpoints share, so tools that read any of them find something. */
export function sample(id = '1') {
  return {
    id, name: `Sample ${id}`, title: `Sample ${id}`, display_name: `notes-${id}.txt`, filename: `notes-${id}.txt`,
    'content-type': 'text/plain', size: 12, url: `${BASE}/files/${id}/download`, html_url: `/courses/1/assignments/${id}`,
    course_id: '1', course_code: 'BIO-101', workflow_state: 'active', due_at: soon(30), start_at: soon(20), end_at: soon(21),
    created_at: soon(-5), updated_at: soon(-1), posted_at: soon(-2), points_possible: 10, submission_types: ['online_text_entry'],
    message: '<p>Hello <b>class</b></p>', body: '<p>Body</p>', description: '<p>Do the <a href="/courses/1/files/7">reading</a>.</p>',
    syllabus_body: '<p>Office hours: Mon 2-3pm, room 101.</p>', comment: 'Nice work',
    plannable_type: 'assignment', plannable_id: id, plannable: { title: `Item ${id}`, due_at: soon(26), points_possible: 10 },
    submissions: { submitted: false }, read_state: 'unread', unread_count: 1, type: 'Announcement',
    enrollments: [{ type: 'student', computed_current_score: 88.5, computed_current_grade: 'B+', computed_final_score: 80, computed_final_grade: 'B-' }],
    submission: { id, score: 9, workflow_state: 'graded', attempt: 1 },
    assignments: [{ id, name: 'HW', points_possible: 10, submission: { score: 9, workflow_state: 'graded' } }, { id: `${id}0`, name: 'Exam', points_possible: 100 }],
    group_weight: 50, participants: [{ id: '5', display_name: 'Alex Example' }], messages: [], view: [], appointments: [],
    calendar: { ics: `${BASE}/feeds/calendars/user_abc.ics` }, unread_conversations: 0,
  };
}

const SINGULAR = /\/(self|profile|settings|quota|summary|todo_item_count|unread_count|late_policy|permissions|progress|course_pacing|syllabus|public_url|time|view|submission|whoami|smartsearch|module_item_sequence|sessionless_launch|custom_data|course_nicknames\/\d+)$|\/\d+$|\/submissions\/self$/;

/**
 * fetch() replacement. `calls` collects every request as { method, path, body } so tests can check what was sent.
 * `override(method, pathname)` may return a { status, body } to change the answer for one path, or { error } to fail
 * the way a lost connection does.
 */
export function fakeFetch({ calls = [], override } = {}) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    const p = u.pathname.replace(/^\/api\/v1/, '');
    calls.push({ method, path: p, query: u.search, body: opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : '[form]') : undefined, url: u.href, auth: opts.headers?.Authorization });
    const custom = override?.(method, p, u);
    if (custom?.error) throw custom.error;
    if (custom) return new Response(typeof custom.body === 'string' ? custom.body : JSON.stringify(custom.body), { status: custom.status || 200, headers: { 'content-type': 'application/json', ...(custom.headers || {}) } });
    if (/\/files\/\d+\/download$|\.ics$/.test(p)) return new Response('Hello from a file', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (method !== 'GET') return new Response(JSON.stringify({ ...sample('99'), marked_complete: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/content_exports\/\d+$/.test(p)) return new Response(JSON.stringify({ id: '3', workflow_state: 'exported', attachment: { url: `${BASE}/files/3/download`, filename: 'course.imscc' } }), { status: 200 });
    if (/user_generated_tokens$/.test(p)) return new Response(JSON.stringify([{ id: '9', token_hint: 'test-', expires_at: soon(24 * 3), workflow_state: 'active' }]), { status: 200 });
    if (/unread_count$/.test(p)) return new Response(JSON.stringify({ unread_count: '2' }), { status: 200 });
    const body = SINGULAR.test(p) ? sample('1') : [sample('1'), sample('2')];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '650' } });
  };
}

/** A server on the fake Canvas plus a connected in-memory client. */
export async function connect({ env = {}, calls = [], override, clientCapabilities = {}, elicitation = true, onElicit, log } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-test-'));
  const built = createCanvasServer({
    env: { CANVAS_API_TOKEN: 'test-token-123456', CANVAS_BASE_URL: BASE, CANVAS_DOWNLOAD_DIR: path.join(dir, 'downloads'), CANVAS_TIMEZONE: 'America/New_York', ...env },
    version: 'test', defaultDownloadDir: path.join(dir, 'downloads'), stateDir: path.join(dir, 'state'),
    fetchImpl: fakeFetch({ calls, override }), elicitation, ...(log ? { log } : {}),
  });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: clientCapabilities });
  if (onElicit) {
    const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    client.setRequestHandler(ElicitRequestSchema, onElicit);
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(a), client.connect(b)]);
  return { client, built, calls, dir, close: async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Minimal valid arguments for a tool, from its JSON input schema: required fields only. */
export function sampleArgs(schema, dir) {
  const args = {};
  for (const key of schema.required || []) {
    const prop = schema.properties[key] || {};
    if (prop.enum) args[key] = prop.enum[0];
    else if (prop.type === 'number' || prop.type === 'integer') args[key] = prop.minimum > 1 ? prop.minimum : 1;
    else if (prop.type === 'boolean') args[key] = false;
    else if (prop.type === 'array') args[key] = key === 'blocks' ? [{ title: 'Study: HW', start: soon(5), end: soon(6) }] : (prop.items?.type === 'number' ? [90] : ['1']);
    else if (prop.type === 'object') args[key] = { a: 1 };
    else if (key === 'file_path') { const f = path.join(dir, 'upload.txt'); fs.writeFileSync(f, 'hi'); args[key] = f; }
    else if (key === 'url') args[key] = `${BASE}/files/1/download`;
    else if (/date|_at$|since/.test(key)) args[key] = soon(1);
    else args[key] = '1';
  }
  return args;
}
