// Tool registration shared by every tool file: which tools are on, their hints for the AI app, confirmation of
// actions other people see, progress updates, paging of long lists and the token-expiry heads-up.
import { z } from 'zod';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DOCS, documentParams, titleFor } from './tool-docs.js';
import { CanvasError } from './canvas-client.js';
import { ok, fail, pick, omitEmpty, addLocalDates, pageOf, capText, DEFAULT_PAGE_SIZE } from './format.js';
import { applyFence, fenceComments } from './text.js';

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

export function createRegistry({ server, canvas, cfg, dates, elicitation = true, notice = () => null, missingTokenHelp = '' }) {
  const registry = [];
  let skipped = 0;

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

  function finish(result) {
    const first = result?.content?.[0];
    if (first?.type === 'text') {
      first.text = capText(first.text, cfg.maxChars);
      const heads = result.isError ? null : notice();
      if (heads) first.text = `${heads}\n\n${first.text}`;
    }
    return result;
  }

  /**
   * Register a tool.
   *   name, description, schema (zod raw shape), handler(args, { progress, signal }), group
   *   write   - changes something (removed when CANVAS_ALLOW_WRITES=false)
   *   confirm - visible to others or irreversible: asks the user first, or needs confirm=true after a dry run
   *   offline - never calls Canvas, so it works before the token is set
   *   local   - only writes files on this computer (downloads), never changes Canvas
   *   output  - zod shape of the structured result; the handler must then return ok(..., { structured })
   */
  function tool({ name, description, schema = {}, handler, write = false, confirm = false, group = '', offline = false, local = false, output }) {
    if (!enabled(name, group, write)) { skipped++; return; }

    const doc = TOOL_DOCS[name] || {};
    if (doc.description) description = doc.description;
    let shape = documentParams(schema, doc.params);
    let desc = description;
    if (confirm) {
      shape = { ...shape, confirm: z.boolean().optional().describe('Must be true to actually execute. Omit or set false to get a dry-run preview first.') };
      desc = `${description} [IRREVERSIBLE: call without confirm=true first to preview, then re-call with confirm=true. Apps that can ask the user directly will show a confirmation instead.]`;
    }

    server.registerTool(name, {
      title: titleFor(name),
      description: desc,
      inputSchema: shape,
      ...(output ? { outputSchema: output } : {}),
      annotations: { ...annotationsFor({ name, write, confirm, offline, local }), ...doc.annotations },
    }, async (args = {}, extra = {}) => {
      try {
        if (!offline) {
          const problem = setupProblem();
          if (problem) return fail(problem);
        }
        const io = { progress: progressFor(extra), signal: extra.signal };
        if (confirm && args.confirm !== true) {
          const preview = typeof handler.preview === 'function' ? await handler.preview(args, io) : null;
          const answer = await askToConfirm(name, preview || args, extra);
          if (answer === 'accept') return finish(await handler({ ...args, confirm: true }, io));
          if (answer === 'decline') return ok(preview || args, 'Cancelled. Nothing was sent to Canvas.');
          return ok(preview || args, `DRY RUN. Nothing was sent to Canvas.\nThis action is visible to other people and cannot be fully undone.\nReview the details below, then call ${name} again with confirm=true to execute.`);
        }
        return finish(await handler(args, io));
      } catch (e) {
        if (e instanceof CanvasError) return fail(e.message);
        return fail(`${name} failed: ${e.message}`);
      }
    });
    registry.push({ name, group, write, confirm, description });
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
          const all = await canvas.paginate(p, q, { max: page * size + 1, ttl });
          ({ rows: data, note } = pageOf(all, { page, size }));
        } else {
          data = await canvas.get(p, q, { ttl });
        }
        if (fields) data = pick(data, fields);
        if (fenceFields) data = applyFence(data, fenceFields, name);
        if (comments) data = fenceComments(data, `${name.replace(/_/g, ' ')}`);
        return ok(omitEmpty(addLocalDates(data, dates.friendly)), note);
      },
    });
  }

  return { tool, get, registry, skipped: () => skipped, ID, COURSE, LIMIT, PAGE };
}
