// Meta. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';
import { PROFILES, profileIncludes, profileChoices } from '../profiles.js';

export default function register(ctx) {
  const { tool, canvas, ok, fail, TOKEN, BASE, API, ALLOW_WRITES, PROFILE, TZ, CACHE_TTL, DOWNLOAD_DIR, SERVER_NAME, SERVER_VERSION, registry, leftOut, catalog, skipped, unknownNames, tokenWatch, localize, cfg, state, elicitation } = ctx;

  const O = 'meta';

  const inProfiles = (t) => PROFILES.filter((p) => profileIncludes(p, t)).map((p) => p.id);
  const profileFacts = { profile: PROFILE, profile_number: cfg.profileNumber, profile_title: cfg.profileTitle };
  const SWITCH = `set CANVAS_PROFILE to one name or number (${profileChoices()}) where this server's settings are (the AI app's Canvas settings, or .env for the Remote server), then restart the AI app (for Remote: canvas-lms-mcp-remote restart)`;
  /** One plain sentence on how to turn on what the given reasons switched off. */
  const howToSwitch = (reasons) => [
    reasons.has('profile') && `The ${cfg.profileTitle} profile leaves some tools out: to turn them on, ${SWITCH}.`,
    reasons.has('writes') && 'CANVAS_ALLOW_WRITES=false turns off every tool that changes Canvas.',
    reasons.has('disabled') && 'CANVAS_DISABLE_TOOLS leaves some out.',
    reasons.has('filter') && 'CANVAS_TOOLS only turns on the groups and tools it names.',
  ].filter(Boolean).join(' ');
  const writesOffBecause = () => (ALLOW_WRITES ? undefined
    : cfg.writesSetting ? `the ${cfg.profileTitle} profile only reads` : 'CANVAS_ALLOW_WRITES is false');

  tool({
    name: 'raw_canvas_request', group: O,
    description: 'Escape hatch: call almost any Canvas API endpoint directly, including anything this server does not wrap. GET needs no confirmation; POST/PUT/DELETE are gated by CANVAS_ALLOW_WRITES and need confirmation.',
    confirm: (a) => a.method !== 'GET' && ALLOW_WRITES,
    preview: async (a) => {
      canvas.check(a.method, a.path, a.params);
      return { action: `${a.method} ${a.path}`, method: a.method, path: a.path, params: a.params, body: a.body };
    },
    schema: {
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
      path: z.string().describe("API path after /api/v1, e.g. '/users/self/enrollments'"),
      params: z.record(z.string(), z.any()).optional().describe('Query parameters'),
      body: z.record(z.string(), z.any()).optional().describe('JSON body for POST/PUT'),
      paginate: z.boolean().optional().describe('Follow Link headers and collect all pages (GET only)'),
      max_items: z.number().int().positive().optional(),
    },
    handler: async (a) => {
      const m = a.method.toUpperCase();
      canvas.check(m, a.path, a.params);
      if (m !== 'GET' && !ALLOW_WRITES) {
        return fail(cfg.writesSetting
          ? `Write methods are off because the ${cfg.profileTitle} profile (CANVAS_PROFILE=${PROFILE}) only reads. Pick a profile that can make changes to use them.`
          : 'Write methods are disabled. Set CANVAS_ALLOW_WRITES=true to enable.');
      }
      if (m === 'GET') {
        const data = a.paginate ? await canvas.paginate(a.path, a.params, { max: a.max_items || 200, ttl: 0 }) : await canvas.get(a.path, a.params, { ttl: 0 });
        return ok(data);
      }
      const data = m === 'POST' ? await canvas.post(a.path, a.body, a.params)
        : m === 'PUT' ? await canvas.put(a.path, a.body, a.params)
        : await canvas.del(a.path, a.params);
      return ok(data);
    },
  });

  tool({
    name: 'search_tools', group: O, offline: true,
    description: 'Search the tools this server exposes by keyword. Useful because the tool surface is large.',
    schema: { query: z.string().optional(), group: z.string().optional() },
    handler: async (a) => {
      const q = (a.query || '').toLowerCase();
      const matches = (t) => (!a.group || t.group === a.group) && (!q || t.name.includes(q) || t.description.toLowerCase().includes(q));
      const rows = registry.filter(matches);
      // Only a real search lists what is switched off: a list of everything would be mostly tools that aren't there.
      const off = q || a.group ? leftOut.filter(matches) : [];
      return ok({
        total_registered: registry.length, matches: rows.length,
        profile: { id: PROFILE, number: cfg.profileNumber, title: cfg.profileTitle },
        groups: [...new Set(registry.map((t) => t.group))],
        tools: rows.map((t) => ({ name: t.name, group: t.group, write: t.write, confirm_required: t.confirm, in_profiles: inProfiles(t), description: t.description.slice(0, 140) })),
        switched_off: off.length ? off.slice(0, 20).map((t) => ({ name: t.name, group: t.group, why: t.why, in_profiles: inProfiles(t) })) : undefined,
        switched_off_total: off.length > 20 ? off.length : undefined,
        how_to_switch: off.length ? howToSwitch(new Set(off.map((t) => t.why))) : undefined,
      });
    },
  });

  tool({
    name: 'test_connection', group: O,
    description: 'Verify the token, base URL and permissions end to end. Run this first if anything is failing.',
    handler: async () => {
      const results = {};
      try { const me = await canvas.get('/users/self', null, { ttl: 0 }); results.identity = { ok: true, id: me.id, name: me.name }; }
      catch (e) { return fail(`Connection failed at the first step.\n${e.message}`); }
      try { const c = await canvas.paginate('/courses', { enrollment_state: 'active' }, { max: 50, ttl: 0 }); results.courses = { ok: true, active_count: c.length, sample: c.slice(0, 5).map((x) => ({ id: x.id, name: x.name })) }; }
      catch (e) { results.courses = { ok: false, error: e.message }; }
      for (const [label, p] of [['planner', '/planner/items'], ['inbox', '/conversations/unread_count'], ['missing_submissions', '/users/self/missing_submissions'], ['todo', '/users/self/todo']]) {
        try { await canvas.get(p, { per_page: 1 }, { ttl: 0 }); results[label] = { ok: true }; }
        catch (e) { results[label] = { ok: false, status: e.status, note: 'Feature may be disabled at your institution.' }; }
      }
      const token = await tokenWatch.check();
      return ok({
        base_url: BASE, api_root: API, writes_enabled: ALLOW_WRITES, ...profileFacts,
        tools_registered: registry.length, tools_skipped: skipped(), timezone: TZ,
        token: token?.expires_at ? { expires: localize(token.expires_at), days_left: Math.floor((new Date(token.expires_at) - Date.now()) / 86400000) } : token ? { expires: 'never' } : 'Could not read the token\'s expiry (your school may hide it).',
        rate_limit: { last_cost: canvas.lastCost, remaining: canvas.lastRemaining },
        checks: results,
      });
    },
  });

  tool({
    name: 'get_server_config', group: O, offline: true,
    description: 'Show how this server is configured and what is enabled, without revealing the token.',
    handler: async () => ok({
      server: SERVER_NAME, version: SERVER_VERSION,
      base_url: BASE || '(unset)', api_root: API || '(unset)',
      token_present: Boolean(TOKEN), token_source: cfg.tokenSource, token_problem: cfg.tokenError || undefined,
      settings_problem: cfg.settingsProblem || undefined,
      writes_enabled: ALLOW_WRITES, writes_off_because: writesOffBecause(),
      ...profileFacts,
      tools_left_out_by_profile: leftOut.filter((t) => t.why === 'profile').length,
      profiles: PROFILES.map((p) => ({ number: p.number, id: p.id, title: p.title, tools: catalog().filter((t) => profileIncludes(p, t)).length })),
      how_to_switch: `To change which tools are on, ${SWITCH}.`,
      tool_filter: cfg.tools ? [...cfg.tools] : 'all groups', tools_left_out: cfg.disabled.size ? [...cfg.disabled] : undefined,
      unknown_tool_names: unknownNames().length ? unknownNames() : undefined,
      confirmations: elicitation ? 'asked in the app when it supports it, otherwise a preview and a one-time token' : 'a preview and a one-time token',
      cache_ttl_seconds: CACHE_TTL / 1000, timezone: TZ, download_dir: DOWNLOAD_DIR,
      remembers_between_runs: state.file || 'nothing (no state folder)',
      max_response_chars: cfg.maxChars,
      ip_family: cfg.ipFamily || 'automatic',
      tools_registered: registry.length, tools_skipped_by_config: skipped(),
      groups: [...new Set(registry.map((t) => t.group))],
      write_tools: registry.filter((t) => t.write).length,
      confirm_gated_tools: registry.filter((t) => t.confirm).length,
      excluded_by_design: ['start_quiz_submission', 'answer_quiz_question', 'complete_quiz_submission'],
    }),
  });
}
