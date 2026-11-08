// Tool registration shared by every tool file: which tools are on, their hints for the AI app, confirmation of
// actions other people see, progress updates, paging of long lists and the token-expiry heads-up.
import crypto from 'node:crypto';
import { z } from 'zod';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DOCS, documentParams, titleFor } from './tool-docs.js';
import { CanvasError, callContext, hideAddresses } from './canvas-client.js';
import { ok, fail, pick, omitEmpty, addLocalDates, pageOf, capText, trimToFit, DEFAULT_PAGE_SIZE } from './format.js';
import { applyFence, fenceComments, fenceProse } from './text.js';

/** The curated subset served when CANVAS_PROFILE=core. */
export const CORE_TOOLS = new Set([
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
]);

// Always available, whatever CANVAS_TOOLS says, so the assistant can still find tools and diagnose problems.
const ALWAYS = new Set(['search_tools', 'test_connection', 'get_server_config']);

// IDs go straight into request paths, so one of these characters would point a harmless tool at a different endpoint.
// Canvas's own forms (self, sis_course_id:BIO-101, 1234~5678, hex:...) don't need them.
const UNSAFE_ID = /[/\\?#%\u0000-\u001f\u007f]|^\.{1,2}$/;
const unsafeId = (args) => Object.keys(args).find((k) => (k === 'id' || /_ids?$/.test(k)) && [].concat(args[k]).some((v) => typeof v === 'string' && UNSAFE_ID.test(v)));

const TOKEN_MINUTES = 5;

// Facts about the target a confirmation is tied to. If one changes after the preview, the preview no longer says what would happen.
const TARGET_STATE = ['assignment_id', 'due_at', 'allowed_attempts', 'attempts_used', 'already_submitted_at', 'file_size_bytes', 'file_sha256', 'updated_at', 'last_message_at', 'start_at', 'end_at'];

const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(sorted(v))).digest();

const DESTRUCTIVE = /^(delete|remove|leave|cancel)_/;
const IDEMPOTENT = /^(mark_|set_|star_|unstar_|subscribe_|unsubscribe_|update_|add_favorite_|remove_favorite_|reset_|dismiss_|delete_|remove_)/;

/** MCP tool hints. Apps use them to decide which tools can run without asking the user first. */
export function annotationsFor({ name, write, confirm, offline, local }) {
  return {
    readOnlyHint: !write && !local,
    destructiveHint: Boolean(write && !local && (confirm || DESTRUCTIVE.test(name))),
    idempotentHint: !write || Boolean(local) || IDEMPOTENT.test(name),
    openWorldHint: !offline,
  };
}

/** A short, readable summary of a dry-run preview for the app's confirmation dialog. */
export function confirmMessage(name, preview) {
  const lines = [`${preview?.action ? String(preview.action) : titleFor(name)}?`, ''];
  for (const [k, v] of Object.entries(preview || {})) {
    if (k === 'action' || v === null || v === undefined || v === '') continue;
    const shown = Array.isArray(v)
      ? v.map((x) => (x && typeof x === 'object' ? x.resolved_name || x.name || x.title || JSON.stringify(x) : x)).join(', ')
      : typeof v === 'object' ? null : String(v);
    if (shown) lines.push(`${k.replace(/_/g, ' ')}: ${shown.length > 400 ? `${shown.slice(0, 400)}…` : shown}`);
  }
  const text = lines.join('\n');
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/** How long a tool that only reads may run. Longer than the 15 minutes a confirmation question waits for an answer. */
export const TOOL_TIMEOUT_MS = 20 * 60000;

export function createRegistry({ server, canvas, cfg, dates, elicitation = true, notice = () => null, missingTokenHelp = '', log = () => {}, toolTimeoutMs = TOOL_TIMEOUT_MS }) {
  const registry = [];
  const known = new Set();
  let skipped = 0;

  /** Failures go in the log too, so they can still be traced after the chat is gone. Hosts only, never full addresses. */
  function logFailure(name, e) {
    const facts = Object.entries({ step: e.step, host: e.host, code: e.code, attempts: e.attempts })
      .filter(([, v]) => v).map(([k, v]) => `${k}=${/\s/.test(v) ? `"${v}"` : v}`);
    log(`${new Date().toISOString()} tool failed: ${[name, ...facts].join(' ')}: ${hideAddresses(e.message).replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  const ID = z.string().describe('Canvas ID (numeric string)');
  const COURSE = z.string().describe('Canvas course ID');
  const LIMIT = z.number().int().positive().optional().describe('Max items to return');
  const PAGE = z.number().int().positive().optional().describe('Page of results');

  function enabled(name, group, write) {
    if (cfg.profile === 'core' && !CORE_TOOLS.has(name)) return false;
    if (write && !cfg.allowWrites) return false;
    if (cfg.disabled.has(name) || cfg.disabled.has(group)) return false;
    if (cfg.tools && !ALWAYS.has(name) && !cfg.tools.has(name) && !cfg.tools.has(group)) return false;
    return true;
  }

  function setupProblem() {
    if (cfg.settingsProblem) return cfg.settingsProblem;
    if (cfg.tokenError) return cfg.tokenError;
    if (!cfg.token) return `CANVAS_API_TOKEN is not set. ${missingTokenHelp}`.trim();
    if (!cfg.api) return 'CANVAS_BASE_URL is not set. Example: https://yourschool.instructure.com';
    return null;
  }

  /** progress(done, total, message) reports to the app when it asked for progress, and does nothing otherwise. */
  function progressFor(extra) {
    const token = extra?._meta?.progressToken;
    if (token === undefined || typeof extra.sendNotification !== 'function') return () => {};
    return (progress, total, message) => extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress, ...(total ? { total } : {}), ...(message ? { message } : {}) },
    }).catch(() => {});
  }

  /**
   * Ask the user to confirm through the app itself (MCP elicitation) when the app supports it.
   * Returns 'accept', 'decline', or 'unsupported' (the caller then falls back to the confirm=true dry run).
   */
  async function askToConfirm(name, preview, extra) {
    if (!elicitation || !server.server.getClientCapabilities()?.elicitation) return 'unsupported';
    const params = {
      message: confirmMessage(name, preview),
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', title: 'Yes, do it', description: 'Other people may see this, and it cannot be fully undone.', default: false } },
        required: ['confirm'],
      },
    };
    try {
      const send = typeof extra?.sendRequest === 'function'
        ? (req, opts) => extra.sendRequest(req, ElicitResultSchema, opts)
        : (req, opts) => server.server.request(req, ElicitResultSchema, opts);
      const r = await send({ method: 'elicitation/create', params }, { timeout: 15 * 60000 });
      return r.action === 'accept' && r.content?.confirm === true ? 'accept' : 'decline';
    } catch {
      return 'unsupported';
    }
  }

  // One-time tokens, in memory only. One per tool and exact request, so a fresh preview replaces the last one.
  const pending = new Map();

  function issueToken(key, state) {
    const now = Date.now();
    for (const [k, held] of pending) if (held.expires < now) pending.delete(k);
    const token = crypto.randomBytes(16).toString('base64url');
    pending.set(key, { token, state, expires: now + TOKEN_MINUTES * 60000 });
    return token;
  }

  /** 'ok' uses the token up. The check and the delete happen together, so two racing calls can't both pass. */
  function redeem(key, token, state) {
    const held = pending.get(key);
    if (!held || held.expires < Date.now() || !crypto.timingSafeEqual(digest(String(token)), digest(held.token))) return 'mismatch';
    pending.delete(key);
    return held.state === state ? 'ok' : 'changed';
  }

  const HEADINGS = {
    preview: 'DRY RUN. Nothing was sent to Canvas.\nThis action is visible to other people or can\'t be fully undone.',
    mismatch: 'That confirmation didn\'t work, so nothing was sent to Canvas: it was already used, it expired, or the request changed.',
    changed: 'This changed after the preview, so nothing was sent to Canvas. Check the new details below.',
  };

  /**
   * Run a tool that needs a person's yes. An app that can ask always does, whatever the arguments say. Otherwise the
   * preview comes back with a one-time token. The model sees that token, so it proves the request wasn't changed after
   * the preview, not that a person agreed: that still rests on the model showing the preview and on the app's own approval.
   */
  async function confirmThenRun(name, handler, showPreview, args, extra, io) {
    const { confirm: _confirm, confirm_token: token, ...request } = args;
    if (token) canvas.cache.clear(); // the check below must see Canvas as it is now
    const details = (typeof showPreview === 'function' ? await showPreview(request, io) : null) || request;
    const run = async () => finish(await handler({ ...request, confirm: true }, io));
    const answer = await askToConfirm(name, details, extra);
    if (answer === 'accept') return run();
    if (answer === 'decline') return ok(details, 'Cancelled. Nothing was sent to Canvas.');
    const key = `${name}:${digest(request).toString('hex')}`;
    const state = digest(pick(details, TARGET_STATE)).toString('hex');
    const outcome = args.confirm === true && token ? redeem(key, token, state) : 'preview';
    if (outcome === 'ok') return run();
    return ok(details, `${HEADINGS[outcome]}\nShow these details to the user and ask whether to go ahead. If they say yes, call ${name} again with the same arguments, confirm=true and confirm_token="${issueToken(key, state)}". It works once, for exactly this request, for ${TOKEN_MINUTES} minutes.`);
  }

  function finish(result) {
    const first = result?.content?.[0];
    if (first?.type === 'text') {
      first.text = capText(first.text, cfg.maxChars);
      if (result.structuredContent !== undefined) {
        const { value, cut } = trimToFit(result.structuredContent, cfg.maxChars);
        if (cut) {
          result.structuredContent = value;
          first.text = `${first.text}\n\n[The structured copy of this answer was shortened to fit: ${cut}. Ask for fewer to see them all.]`;
        }
      }
      const cuts = callContext.getStore()?.cut || [];
      const lists = cuts.length && !result.isError
        ? `Heads-up: Canvas had more than this server reads in one go, so ${[...new Set(cuts.map((c) => `${c.path.replace(/\?.*$/, '').replace(/\d+/g, 'N')} stopped at ${c.count} items`))].join('; ')}. Totals and lists here may be incomplete. Narrow the request, such as one course or a shorter date range, to see the rest.`
        : null;
      const heads = [lists, result.isError ? null : notice()].filter(Boolean).join('\n\n');
      if (heads) first.text = `${heads}\n\n${first.text}`;
    }
    return result;
  }

  /**
   * Register a tool.
   *   name, description, schema (zod raw shape), handler(args, { progress, signal }), group
   *   write   - changes something (removed when CANVAS_ALLOW_WRITES=false)
   *   confirm - visible to others or irreversible: asks the user first, or needs a preview and its one-time token.
   *             A function decides per call, for a tool that only sometimes changes something
   *   preview - async (args) => what the user should see before saying yes. Also read from handler.preview
   *   offline - never calls Canvas, so it works before the token is set
   *   local   - only writes files on this computer (downloads), never changes Canvas
   *   output  - zod shape of the structured result; the handler must then return ok(..., { structured })
   */
  function tool({ name, description, schema = {}, handler, preview, write = false, confirm = false, group = '', offline = false, local = false, output }) {
    known.add(name);
    if (group) known.add(group);
    if (!enabled(name, group, write)) { skipped++; return; }

    const doc = TOOL_DOCS[name] || {};
    if (doc.description) description = doc.description;
    let shape = documentParams(schema, doc.params);
    let desc = description;
    const gated = typeof confirm === 'function' ? confirm : () => confirm;
    if (confirm) {
      shape = {
        ...shape,
        confirm: z.boolean().optional().describe('Set to true together with confirm_token to carry out a request you already previewed.'),
        confirm_token: z.string().optional().describe('The one-time token from the preview. Only use it after the user has said yes.'),
      };
      desc = `${description} [NEEDS CONFIRMATION: call it once for a preview and a confirm_token, show the preview to the user, and only if they say yes call it again with the same arguments, confirm=true and that confirm_token. Apps that can ask the user directly show a confirmation instead.]`;
    }

    server.registerTool(name, {
      title: titleFor(name),
      description: desc,
      inputSchema: shape,
      ...(output ? { outputSchema: output } : {}),
      annotations: { ...annotationsFor({ name, write, confirm, offline, local }), ...doc.annotations },
    }, async (args = {}, extra = {}) => {
      const run = async (signal) => {
        try {
          const bad = unsafeId(args);
          if (bad) return fail(`Refused: ${bad} isn't a Canvas ID, because IDs can't contain / \\ ? # or %. Nothing was sent.`);
          if (!offline) {
            const problem = setupProblem();
            if (problem) return fail(problem);
          }
          const io = { progress: progressFor(extra), signal };
          if (gated(args)) return await confirmThenRun(name, handler, preview || handler.preview, args, extra, io);
          return finish(await handler(args, io));
        } catch (e) {
          if (e?.code !== 'STOPPED') logFailure(name, e);
          if (e instanceof CanvasError) return fail(e.message);
          return fail(`${name} failed: ${e.message}`);
        }
      };
      // A change to Canvas always runs to the end, so it never stops between its steps.
      if (write) return callContext.run({ cut: [] }, () => run(extra.signal));
      // Anything else stops asking Canvas when the app gives up on it, or once it has run too long.
      const stop = new AbortController();
      const cancel = () => stop.abort();
      if (extra.signal?.aborted) cancel();
      else extra.signal?.addEventListener?.('abort', cancel, { once: true });
      let timer;
      const ceiling = new Promise((resolve) => {
        timer = setTimeout(() => {
          cancel();
          resolve(fail(`${name} was stopped after ${Math.round(toolTimeoutMs / 60000) || 1} minute(s), because it was taking too long. Try a smaller request, such as one course or a shorter date range.`));
        }, toolTimeoutMs);
        timer.unref?.();
      });
      const work = callContext.run({ signal: stop.signal, cut: [] }, () => run(stop.signal));
      try {
        return await Promise.race([work, ceiling]);
      } finally {
        clearTimeout(timer);
        extra.signal?.removeEventListener?.('abort', cancel);
      }
    });
    registry.push({ name, group, write, confirm: Boolean(confirm), description });
  }

  /**
   * Shorthand for a plain GET tool. Paginated tools show one page at a time (limit items, default 50) and say when
   * there is more. Text other people wrote (fenceFields, comments) is fenced; timestamps get readable companions.
   */
  function get({ name, description, path: pathFn, schema = {}, params, paginate = false, max = 200, fields, fenceFields, comments = false, ttl, group }) {
    const shape = paginate ? { ...schema, limit: schema.limit || LIMIT, page: PAGE } : schema;
    tool({
      name, description, schema: shape, group,
      handler: async (a) => {
        const p = typeof pathFn === 'function' ? pathFn(a) : pathFn;
        const q = typeof params === 'function' ? params(a) : params;
        let data;
        let note = null;
        if (paginate) {
          const size = Math.min(a.limit || Math.min(max, DEFAULT_PAGE_SIZE), 500);
          const page = a.page || 1;
          const all = await canvas.paginate(p, q, { max: page * size + 1, ttl, quiet: true });
          ({ rows: data, note } = pageOf(all, { page, size }));
        } else {
          data = await canvas.get(p, q, { ttl });
        }
        if (fields) data = pick(data, fields);
        if (fenceFields) data = applyFence(data, fenceFields, name);
        if (comments) data = fenceComments(data, `${name.replace(/_/g, ' ')}`);
        // Everything here came straight from Canvas, so any prose left at any depth is someone else's text.
        data = fenceProse(data, name.replace(/_/g, ' '));
        return ok(omitEmpty(addLocalDates(data, dates.friendly)), note);
      },
    });
  }

  /** Names in CANVAS_TOOLS and CANVAS_DISABLE_TOOLS that match no tool or group, so they did nothing. */
  const unknownNames = () => [...cfg.disabled, ...(cfg.tools || [])].filter((n) => !known.has(n));

  return { tool, get, registry, skipped: () => skipped, unknownNames, ID, COURSE, LIMIT, PAGE };
}
