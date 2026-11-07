// Identity and diagnostics. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { matchToken } from '../token-watch.js';
import { z } from 'zod';

export default function register(ctx) {
  const { tool, get, canvas, ok, ID, COURSE, LIMIT, API, TOKEN, BASE, localize, omitEmpty } = ctx;

  const A = 'identity';

  get({ name: 'whoami', group: A, description: 'Get the current Canvas user (id, name, login). Cheapest way to verify the token works.', path: '/users/self', fields: ['id', 'name', 'short_name', 'sortable_name', 'login_id', 'email', 'time_zone', 'locale', 'effective_locale'] });
  get({ name: 'get_my_profile', group: A, description: 'Full profile for the current user: bio, avatar, primary email, calendar feed URL.', path: '/users/self/profile' });
  get({ name: 'get_my_settings', group: A, description: 'User-level Canvas settings (dashboard view, activity stream visibility, comment notifications).', path: '/users/self/settings' });

  tool({
    name: 'check_token_expiry', group: A,
    description: 'Check whether your Canvas access token is near expiry. Canvas forces expiration on student-role tokens (commonly 30-120 days) and does not warn you. Run this at the start of a term.',
    handler: async () => {
      const me = await canvas.get('/users/self', null, { ttl: 0 });
      let tokens = null, note = '';
      try {
        tokens = await canvas.get(`/users/${me.id}/user_generated_tokens`, { per_page: 100 }, { ttl: 0 });
      } catch (e) {
        note = `Could not list tokens (${e.status || '?'}). Many institutions restrict this endpoint. Token itself is valid, since /users/self succeeded.`;
      }
      const rows = (tokens || []).map((t) => ({
        id: t.id, app: t.app_name || t.purpose || 'manual', workflow_state: t.workflow_state,
        created_at: t.created_at, expires_at: t.expires_at,
        days_left: t.expires_at ? Math.round((new Date(t.expires_at) - Date.now()) / 86400000) : 'no expiry',
        last_used_at: t.last_used_at,
      }));
      const soon = rows.filter((r) => typeof r.days_left === 'number' && r.days_left <= 14);
      const mine = matchToken(tokens || [], TOKEN);
      const mineRow = mine && rows.find((r) => String(r.id) === String(mine.id));
      return ok({
        authenticated_as: { id: me.id, name: me.name },
        this_server_token: mineRow ? { ...mineRow, expires_local: mineRow.expires_at ? localize(mineRow.expires_at) : 'never' } : (tokens ? 'Could not tell which of these tokens this server uses.' : null),
        tokens: rows,
        warning: soon.length ? `${soon.length} token(s) expire within 14 days.` : null,
        renew: `Make a new token at ${BASE}/profile/settings (Approved Integrations, + New Access Token), then update it in your AI app or with the Installer Assistant's Auto update.`,
        note: note || null,
      });
    },
  });

  tool({
    name: 'get_rate_limit_status', group: A, offline: true,
    description: 'Report the Canvas rate-limit state observed on the most recent API call. Canvas throttles by cumulative request COST, not request count.',
    handler: async () => ok({
      requests_this_session: canvas.requestCount,
      last_request_cost: canvas.lastCost,
      quota_remaining: canvas.lastRemaining,
      cache_entries: canvas.cache.size,
      note: 'Requests are serialized by design. Canvas penalizes parallel requests with a pre-flight cost that is refunded only on completion.',
    }),
  });

  get({ name: 'list_my_enrollments', group: A, description: 'All enrollments for the current user across courses, including role, section, and grade summary.', path: '/users/self/enrollments', params: (a) => ({ state: a.state || ['active', 'invited'], type: a.type }), schema: { state: z.array(z.string()).optional().describe('active, invited, completed, inactive'), type: z.array(z.string()).optional(), limit: LIMIT }, paginate: true });
  get({ name: 'get_activity_stream', group: A, description: 'Recent activity across all courses: new announcements, discussion replies, grade changes, messages.', path: '/users/self/activity_stream', schema: { limit: LIMIT, only_active_courses: z.boolean().optional() }, params: (a) => ({ only_active_courses: a.only_active_courses ?? true }), paginate: true, max: 50, fenceFields: ['message', 'title'] });
  get({ name: 'get_activity_stream_summary', group: A, description: 'Counts of unread items by type. Very cheap. Use before pulling the full stream.', path: '/users/self/activity_stream/summary' });
  get({ name: 'list_todo', group: A, description: "Canvas's own TODO list for the current user: assignments needing submission and items needing grading.", path: '/users/self/todo', paginate: true, max: 100 });
  get({ name: 'get_todo_count', group: A, description: 'Count of TODO items without fetching them. Cheap.', path: '/users/self/todo_item_count' });
  get({ name: 'list_upcoming_events', group: A, description: 'Upcoming calendar events and assignments for the current user (Canvas-defined window).', path: '/users/self/upcoming_events' });
  get({ name: 'get_dashboard_cards', group: A, description: 'Dashboard course cards: exactly the courses Canvas shows you on the homepage, with colors and quick links.', path: '/dashboard/dashboard_cards' });
  get({ name: 'list_favorite_courses', group: A, description: 'Courses starred as favorites (these drive the dashboard).', path: '/users/self/favorites/courses', paginate: true });
  tool({ name: 'add_favorite_course', group: A, write: true, description: 'Star a course as a favorite so it appears on your dashboard.', schema: { course_id: COURSE }, handler: async (a) => ok(await canvas.post(`/users/self/favorites/courses/${a.course_id}`)) });
  tool({ name: 'remove_favorite_course', group: A, write: true, description: 'Unstar a course, removing it from your dashboard.', schema: { course_id: COURSE }, handler: async (a) => ok(await canvas.del(`/users/self/favorites/courses/${a.course_id}`)) });
  get({ name: 'get_communication_channels', group: A, description: 'Notification delivery channels (email addresses, SMS, push) registered on your account.', path: '/users/self/communication_channels', paginate: true });
  get({ name: 'get_notification_preferences', group: A, description: 'Notification preferences for one communication channel (how often Canvas emails you about each event type).', path: (a) => `/users/self/communication_channels/${a.channel_id}/notification_preferences`, schema: { channel_id: ID } });
  get({ name: 'get_my_page_views', group: A, description: 'Your own Canvas page view history. Useful for proving you accessed material on a given date.', path: '/users/self/page_views', schema: { start_time: z.string().optional().describe('ISO 8601'), end_time: z.string().optional(), limit: LIMIT }, params: (a) => ({ start_time: a.start_time, end_time: a.end_time }), paginate: true, max: 100 });
  get({ name: 'list_content_shares', group: A, description: 'Course content other users have shared directly with you.', path: '/users/self/content_shares/received', paginate: true });
  get({ name: 'get_custom_data', group: A, description: 'Read arbitrary key-value data stored on your Canvas account. Canvas provides this as a free per-user store; useful for persisting notes or state server-side.', path: (a) => `/users/self/custom_data${a.scope ? '/' + a.scope : ''}`, params: (a) => ({ ns: a.namespace || 'canvas-mcp' }), schema: { namespace: z.string().optional().describe('Namespace, default canvas-mcp'), scope: z.string().optional() } });
  tool({ name: 'set_custom_data', group: A, write: true, description: 'Write arbitrary key-value data to your Canvas account custom-data store.', schema: { data: z.record(z.string(), z.any()).describe('Object to store'), namespace: z.string().optional(), scope: z.string().optional() }, handler: async (a) => ok(await canvas.put(`/users/self/custom_data${a.scope ? '/' + a.scope : ''}`, { ns: a.namespace || 'canvas-mcp', data: a.data })) });
  get({ name: 'list_bookmarks', group: A, description: 'Your saved Canvas bookmarks.', path: '/users/self/bookmarks', paginate: true });
  tool({ name: 'create_bookmark', group: A, write: true, description: 'Save a Canvas bookmark pointing at a course URL.', schema: { name: z.string(), url: z.string().describe('Canvas-relative URL, e.g. /courses/123/assignments/456'), position: z.number().int().optional() }, handler: async (a) => ok(await canvas.post('/users/self/bookmarks', { name: a.name, url: a.url, position: a.position })) });
  tool({ name: 'delete_bookmark', group: A, write: true, confirm: true, preview: async (a) => { const b = await canvas.get(`/users/self/bookmarks/${a.bookmark_id}`); return { action: 'DELETE this bookmark', name: b.name, url: b.url }; }, description: 'Delete a saved Canvas bookmark.', schema: { bookmark_id: ID }, handler: async (a) => ok(await canvas.del(`/users/self/bookmarks/${a.bookmark_id}`)) });
  get({ name: 'list_my_observees', group: A, description: 'Users you observe (linked students). Mostly relevant for parent/observer accounts.', path: '/users/self/observees', paginate: true });

  get({ name: 'list_notification_categories', group: A, description: 'The notification categories on one delivery channel (email, phone) and how often Canvas currently notifies you about each, e.g. due dates, grading, announcements. Use with update_notification_preference.', path: (a) => `/users/self/communication_channels/${a.channel_id}/notification_preference_categories`, schema: { channel_id: ID } });

  const PREF_FREQ = ['immediately', 'daily', 'weekly', 'never'];
  const updatePref = async (a) => {
    const r = await canvas.put(`/users/self/communication_channels/${a.channel_id}/notification_preference_categories/${encodeURIComponent(a.category)}`, { notification_preferences: { frequency: a.frequency } });
    return ok(r, `Canvas will now notify you ${a.frequency === 'never' ? 'never' : a.frequency} about "${a.category}" on this channel.`);
  };
  updatePref.preview = async (a) => {
    const current = await canvas.get(`/users/self/communication_channels/${a.channel_id}/notification_preferences`).catch(() => null);
    const prefs = (current?.notification_preferences || []).filter((p) => p.category === a.category || String(p.category || '').replace(/\s+/g, '_') === a.category);
    return { action: 'Change how often Canvas notifies you', channel_id: a.channel_id, category: a.category, from: [...new Set(prefs.map((p) => p.frequency))].join(', ') || 'unknown', to: a.frequency, visible_to: 'only you' };
  };
  tool({
    name: 'update_notification_preference', group: A, write: true, confirm: true,
    description: 'Change how often Canvas emails or texts you about one kind of event, e.g. "grading" only weekly, or "announcement" immediately. Only affects your own notifications.',
    schema: {
      channel_id: ID,
      category: z.string().describe('Category name from list_notification_categories, e.g. "due_date", "grading", "announcement", "conversation_message".'),
      frequency: z.enum(PREF_FREQ).describe('"immediately", "daily", "weekly" or "never".'),
    },
    handler: updatePref,
  });
}
