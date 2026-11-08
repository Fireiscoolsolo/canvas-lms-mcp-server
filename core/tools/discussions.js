// Discussions and announcements. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';

export default function register(ctx) {
  const { tool, get, canvas, ok, pick, omitEmpty, fence, html2text, assertClean, localize, iso, daysFromNow, ID, COURSE, LIMIT, TOPIC_FIELDS, friendly, activeCourses } = ctx;

  const G = 'discussions';

  get({ name: 'list_topics', group: G, description: 'Discussion topics in a course, with unread counts and whether an initial post is required before you can see replies.', path: (a) => `/courses/${a.course_id}/discussion_topics`, schema: { course_id: COURSE, only_announcements: z.boolean().optional(), search_term: z.string().optional(), limit: LIMIT }, params: (a) => ({ only_announcements: a.only_announcements, search_term: a.search_term, order_by: 'recent_activity' }), paginate: true, fields: TOPIC_FIELDS });
  get({ name: 'get_topic', group: G, description: 'One discussion topic with its prompt. Body is provenance-fenced.', path: (a) => `/courses/${a.course_id}/discussion_topics/${a.topic_id}`, schema: { course_id: COURSE, topic_id: ID }, fenceFields: ['message'] });

  tool({
    name: 'get_full_topic_view', group: G,
    description: 'Fetch an ENTIRE discussion thread (all entries and nested replies) in a single request instead of paginating. Much cheaper on rate limits. All participant text is provenance-fenced because classmates wrote it.',
    schema: { course_id: COURSE, topic_id: ID, max_entries: z.number().int().positive().optional() },
    handler: async (a) => {
      const v = await canvas.get(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/view`);
      const names = new Map((v.participants || []).map((p) => [String(p.id), p.display_name || p.short_name]));
      const limit = a.max_entries || 150;
      let count = 0;
      const walk = (entries = []) => entries.filter(() => count < limit).map((e) => {
        count++;
        return {
          id: e.id, author: names.get(String(e.user_id)) || e.user_id, created_at: e.created_at, created_local: localize(e.created_at),
          deleted: e.deleted || undefined, rating_sum: e.rating_sum || undefined,
          message: e.deleted ? '[deleted]' : fence(html2text(e.message), `discussion post by ${names.get(String(e.user_id)) || 'participant'}`),
          replies: e.replies?.length ? walk(e.replies) : undefined,
        };
      });
      return ok(omitEmpty({ topic_id: a.topic_id, participant_count: (v.participants || []).length, entries_returned: count, unread_entry_ids: v.unread_entries, entries: walk(v.view) }));
    },
  });

  get({ name: 'list_entries', group: G, description: 'Top-level entries in a discussion topic (paginated form).', path: (a) => `/courses/${a.course_id}/discussion_topics/${a.topic_id}/entries`, schema: { course_id: COURSE, topic_id: ID, limit: LIMIT }, paginate: true, max: 100, fenceFields: ['message'] });
  get({ name: 'list_entry_replies', group: G, description: 'Replies nested under one discussion entry.', path: (a) => `/courses/${a.course_id}/discussion_topics/${a.topic_id}/entries/${a.entry_id}/replies`, schema: { course_id: COURSE, topic_id: ID, entry_id: ID, limit: LIMIT }, paginate: true, fenceFields: ['message'] });

  const postEntry = async (a) => { assertClean(a.message, 'discussion post'); const r = await canvas.post(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/entries`, { message: a.message }); return ok(pick(r, ['id', 'created_at', 'message']), 'Posted.'); };
  postEntry.preview = async (a) => { const t = await canvas.get(`/courses/${a.course_id}/discussion_topics/${a.topic_id}`); return { course_id: a.course_id, topic: t.title, visible_to: 'everyone in the course', locked: t.locked, message: a.message }; };
  tool({ name: 'post_entry', group: G, write: true, confirm: true, description: 'Post a new top-level entry to a course discussion. Visible to the whole class.', schema: { course_id: COURSE, topic_id: ID, message: z.string() }, handler: postEntry });

  const replyEntry = async (a) => { assertClean(a.message, 'discussion reply'); const r = await canvas.post(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/entries/${a.entry_id}/replies`, { message: a.message }); return ok(pick(r, ['id', 'created_at', 'message']), 'Replied.'); };
  replyEntry.preview = async (a) => ({ course_id: a.course_id, topic_id: a.topic_id, replying_to_entry: a.entry_id, visible_to: 'everyone in the course', message: a.message });
  tool({ name: 'reply_to_entry', group: G, write: true, confirm: true, description: 'Reply to a specific discussion entry. Visible to the whole class.', schema: { course_id: COURSE, topic_id: ID, entry_id: ID, message: z.string() }, handler: replyEntry });

  tool({ name: 'edit_my_entry', group: G, write: true, confirm: true, description: 'Edit one of your own discussion entries, if the course allows editing.', schema: { course_id: COURSE, topic_id: ID, entry_id: ID, message: z.string() }, handler: async (a) => { assertClean(a.message, 'edited post'); return ok(await canvas.put(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/entries/${a.entry_id}`, { message: a.message }), 'Edited.'); } });
  tool({ name: 'delete_my_entry', group: G, write: true, confirm: true, preview: async (a) => { const [e] = await canvas.get(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/entry_list`, { ids: [a.entry_id] }).catch(() => []); return { action: 'DELETE your discussion entry', course_id: a.course_id, topic_id: a.topic_id, entry_id: a.entry_id, updated_at: e?.updated_at }; }, description: 'Delete one of your own discussion entries.', schema: { course_id: COURSE, topic_id: ID, entry_id: ID }, handler: async (a) => ok(await canvas.del(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/entries/${a.entry_id}`), 'Deleted.') });
  tool({ name: 'rate_entry', group: G, write: true, confirm: true, preview: async (a) => ({ action: a.rating ? 'LIKE this discussion entry, which classmates can see' : 'REMOVE your like from this discussion entry', ...a }), description: 'Like/rate a discussion entry, where the instructor enabled rating.', schema: { course_id: COURSE, topic_id: ID, entry_id: ID, rating: z.number().int().min(0).max(1).describe('1 to like, 0 to remove') }, handler: async (a) => ok(await canvas.post(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/entries/${a.entry_id}/rating`, { rating: a.rating })) });
  tool({ name: 'mark_topic_read', group: G, write: true, description: 'Mark a discussion topic as read.', schema: { course_id: COURSE, topic_id: ID }, handler: async (a) => { await canvas.put(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/read`); return ok({ marked_read: true }); } });
  tool({ name: 'mark_all_entries_read', group: G, write: true, description: 'Mark every entry in a discussion topic as read.', schema: { course_id: COURSE, topic_id: ID }, handler: async (a) => { await canvas.put(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/read_all`); return ok({ marked_all_read: true }); } });
  tool({ name: 'mark_entry_read', group: G, write: true, description: 'Mark one discussion entry as read.', schema: { course_id: COURSE, topic_id: ID, entry_id: ID }, handler: async (a) => { await canvas.put(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/entries/${a.entry_id}/read`); return ok({ marked_read: true }); } });
  tool({ name: 'subscribe_topic', group: G, write: true, description: 'Subscribe to a discussion topic to get notified of replies.', schema: { course_id: COURSE, topic_id: ID }, handler: async (a) => { await canvas.put(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/subscribed`); return ok({ subscribed: true }); } });
  tool({ name: 'unsubscribe_topic', group: G, write: true, description: 'Unsubscribe from a discussion topic.', schema: { course_id: COURSE, topic_id: ID }, handler: async (a) => { await canvas.del(`/courses/${a.course_id}/discussion_topics/${a.topic_id}/subscribed`); return ok({ subscribed: false }); } });

  tool({
    name: 'list_announcements', group: G,
    description: 'Announcements across one or many courses in a single call. Announcement bodies are provenance-fenced.',
    schema: { course_ids: z.array(z.string()).optional().describe('Course IDs; omit for all active courses'), start_date: z.string().optional(), end_date: z.string().optional(), unread_only: z.boolean().optional().describe('If true, only announcements you have not read yet.'), limit: LIMIT },
    handler: async (a) => {
      let ids = a.course_ids;
      if (!ids?.length) {
        const courses = await canvas.paginate('/courses', { enrollment_state: 'active' }, { max: 40 });
        ids = courses.map((c) => String(c.id));
      }
      const rows = await canvas.paginate('/announcements', {
        context_codes: ids.map((i) => `course_${i}`),
        start_date: a.start_date || iso(daysFromNow(-30)), end_date: a.end_date || iso(daysFromNow(1)),
        active_only: true,
      }, { max: a.limit || 60 });
      return ok(rows.filter((r) => !a.unread_only || r.read_state !== 'read').map((r) => ({
        id: r.id, title: r.title, course_context: r.context_code, posted_at: r.posted_at, posted_local: localize(r.posted_at),
        read_state: r.read_state, html_url: r.html_url,
        message: fence(html2text(r.message), `announcement: ${r.title}`),
      })));
    },
  });

  get({ name: 'get_unread_discussion_count', group: G, description: 'Unread discussion counts per topic in a course. Cheap.', path: (a) => `/courses/${a.course_id}/discussion_topics`, schema: { course_id: COURSE }, paginate: true, fields: ['id', 'title', 'unread_count', 'read_state', 'last_reply_at'] });

  // School-wide notices. Canvas resolves "self" to your school's main account; older setups need the
  // account ID from one of your courses instead.
  async function accountNotifications() {
    try {
      return { account: 'self', rows: await canvas.paginate('/accounts/self/account_notifications', null, { max: 50, ttl: 300000 }) };
    } catch (e) {
      const courses = await activeCourses(5).catch(() => []);
      const root = courses.find((c) => c.root_account_id || c.account_id);
      if (!root) throw e;
      const account = root.root_account_id || root.account_id;
      return { account, rows: await canvas.paginate(`/accounts/${account}/account_notifications`, null, { max: 50, ttl: 300000 }) };
    }
  }

  tool({
    name: 'list_global_announcements', group: G,
    description: 'School-wide announcements: the banners your school shows everyone on the Canvas dashboard (closures, outages, deadlines). Read-only. Messages are provenance-fenced.',
    handler: async () => {
      const { account, rows } = await accountNotifications();
      return ok({
        count: rows.length, account_id: account,
        announcements: rows.map((n) => omitEmpty({
          id: n.id, subject: n.subject, kind: n.icon, starts: friendly(n.start_at), ends: friendly(n.end_at),
          message: fence(html2text(n.message), `school announcement: ${n.subject}`),
        })),
        note: rows.length ? undefined : 'No school-wide announcements right now.',
      });
    },
  });

  tool({
    name: 'dismiss_global_announcement', group: G, write: true,
    description: 'Close a school-wide announcement so it stops showing on your Canvas dashboard. Only affects you.',
    schema: {
      notification_id: ID.describe('Announcement ID from list_global_announcements.'),
      account_id: z.string().optional().describe('account_id from list_global_announcements. Default "self".'),
    },
    handler: async (a) => {
      await canvas.del(`/accounts/${a.account_id || 'self'}/account_notifications/${a.notification_id}`);
      return ok({ dismissed: a.notification_id }, 'Dismissed. It will no longer show on your dashboard.');
    },
  });

  tool({
    name: 'mark_announcement_read', group: G, write: true,
    description: 'Mark one course announcement as read, clearing its unread badge.',
    schema: { course_id: COURSE, announcement_id: ID.describe('Announcement ID from list_announcements.') },
    handler: async (a) => { await canvas.put(`/courses/${a.course_id}/discussion_topics/${a.announcement_id}/read`); return ok({ marked_read: a.announcement_id }); },
  });

  tool({
    name: 'mark_all_announcements_read', group: G, write: true,
    description: 'Mark every unread announcement in the last N days as read, across all your courses or the ones you pick. Clears the unread badges in Canvas.',
    schema: {
      course_ids: z.array(z.string()).optional().describe('Course IDs; omit for all active courses.'),
      days: z.number().int().positive().max(365).optional().describe('How far back to look. Default 30.'),
    },
    handler: async (a) => {
      const ids = a.course_ids?.length ? a.course_ids : (await activeCourses()).map((c) => String(c.id));
      const rows = await canvas.paginate('/announcements', {
        context_codes: ids.map((i) => `course_${i}`), start_date: iso(daysFromNow(-(a.days || 30))), end_date: iso(daysFromNow(1)), active_only: true,
      }, { max: 300, ttl: 0 });
      const unread = rows.filter((r) => r.read_state !== 'read');
      let marked = 0;
      const failed = [];
      for (const r of unread) {
        const course = String(r.context_code || '').replace(/^course_/, '');
        try { await canvas.put(`/courses/${course}/discussion_topics/${r.id}/read`); marked++; } catch (e) { failed.push({ title: r.title, error: e.message }); }
      }
      return ok(omitEmpty({ checked: rows.length, marked_read: marked, failed }), marked ? `Marked ${marked} announcement${marked === 1 ? '' : 's'} as read.` : 'Nothing unread.');
    },
  });
}
