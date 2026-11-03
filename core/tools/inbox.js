// Inbox / conversations. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';

export default function register(ctx) {
  const { tool, get, canvas, ok, fence, html2text, assertClean, localize, ID, LIMIT } = ctx;

  const H = 'inbox';

  get({ name: 'list_conversations', group: H, comments: true, description: 'Canvas Inbox conversations. Scope: inbox, unread, starred, archived, sent.', path: '/conversations', schema: { scope: z.enum(['inbox', 'unread', 'starred', 'archived', 'sent']).optional(), filter: z.array(z.string()).optional().describe('e.g. course_123'), limit: LIMIT }, params: (a) => ({ scope: a.scope || 'inbox', filter: a.filter, include_all_conversation_ids: false }), paginate: true, max: 50, fields: ['id', 'subject', 'workflow_state', 'last_message_at', 'message_count', 'subscribed', 'starred', 'participants', 'context_name', 'last_message'] });

  tool({
    name: 'get_conversation', group: H,
    description: 'Full message thread for one conversation. All message bodies are provenance-fenced; other people wrote them.',
    schema: { conversation_id: ID, mark_as_read: z.boolean().optional().describe('Default false') },
    handler: async (a) => {
      const c = await canvas.get(`/conversations/${a.conversation_id}`, { auto_mark_as_read: a.mark_as_read ? 1 : 0 }, { ttl: 0 });
      const names = new Map((c.participants || []).map((p) => [String(p.id), p.name || p.full_name]));
      return ok({
        id: c.id, subject: c.subject, context: c.context_name, starred: c.starred, state: c.workflow_state,
        participants: (c.participants || []).map((p) => ({ id: p.id, name: p.name })),
        messages: (c.messages || []).map((m) => ({
          id: m.id, from: names.get(String(m.author_id)) || m.author_id, created_at: m.created_at, created_local: localize(m.created_at),
          body: fence(html2text(m.body), `inbox message from ${names.get(String(m.author_id)) || 'unknown'}`),
          attachments: (m.attachments || []).map((f) => ({ id: f.id, filename: f.filename, url: f.url })),
        })),
      });
    },
  });

  const sendMsg = async (a) => {
    assertClean(a.body, 'message body');
    const r = await canvas.post('/conversations', { recipients: a.recipients, subject: a.subject, body: a.body, context_code: a.course_id ? `course_${a.course_id}` : undefined, group_conversation: a.recipients.length > 1 ? true : undefined, bulk_message: a.separate_threads ? true : undefined });
    return ok(r, 'Message sent.');
  };
  sendMsg.preview = async (a) => {
    let resolved = [];
    try {
      const found = await canvas.get('/conversations/find_recipients', { search: '', context: a.course_id ? `course_${a.course_id}` : undefined, per_page: 50 });
      const map = new Map((found || []).map((f) => [String(f.id), f.name]));
      resolved = a.recipients.map((r) => ({ id: r, resolved_name: map.get(String(r)) || '(not resolved; verify with find_recipients)' }));
    } catch { resolved = a.recipients.map((r) => ({ id: r, resolved_name: '(lookup unavailable)' })); }
    return { action: 'SEND a Canvas Inbox message', recipients: resolved, subject: a.subject, course_context: a.course_id || null, body: a.body, warning: 'This is delivered to real people and cannot be unsent.' };
  };
  tool({ name: 'send_message', group: H, write: true, confirm: true, description: 'Send a new Canvas Inbox message, e.g. to a professor. Use find_recipients first to get recipient IDs.', schema: { recipients: z.array(z.string()).describe('Canvas user IDs from find_recipients'), subject: z.string(), body: z.string(), course_id: z.string().optional().describe('Course context, recommended'), separate_threads: z.boolean().optional().describe('Send individually rather than as a group thread') }, handler: sendMsg });

  const replyMsg = async (a) => { assertClean(a.body, 'reply body'); return ok(await canvas.post(`/conversations/${a.conversation_id}/add_message`, { body: a.body, included_messages: a.included_message_ids }), 'Reply sent.'); };
  replyMsg.preview = async (a) => { const c = await canvas.get(`/conversations/${a.conversation_id}`, null, { ttl: 0 }); return { action: 'REPLY in an existing Inbox thread', subject: c.subject, participants: (c.participants || []).map((p) => p.name), body: a.body, warning: 'Delivered to real people; cannot be unsent.' }; };
  tool({ name: 'reply_to_conversation', group: H, write: true, confirm: true, description: 'Reply within an existing Canvas Inbox conversation.', schema: { conversation_id: ID, body: z.string(), included_message_ids: z.array(z.string()).optional() }, handler: replyMsg });

  get({ name: 'find_recipients', group: H, description: 'Search for people you are allowed to message. Returns the user IDs required by send_message.', path: '/conversations/find_recipients', schema: { search: z.string().describe('Name fragment'), course_id: z.string().optional(), limit: LIMIT }, params: (a) => ({ search: a.search, context: a.course_id ? `course_${a.course_id}` : undefined, per_page: 50, synthetic_contexts: 1 }) });
  tool({ name: 'add_recipients', group: H, write: true, confirm: true, description: 'Add more people to an existing conversation thread.', schema: { conversation_id: ID, recipients: z.array(z.string()) }, handler: async (a) => ok(await canvas.post(`/conversations/${a.conversation_id}/add_recipients`, { recipients: a.recipients })) });
  tool({ name: 'mark_conversation_read', group: H, write: true, description: 'Mark a conversation as read.', schema: { conversation_id: ID }, handler: async (a) => ok(await canvas.put(`/conversations/${a.conversation_id}`, { conversation: { workflow_state: 'read' } })) });
  tool({ name: 'mark_conversation_unread', group: H, write: true, description: 'Mark a conversation as unread.', schema: { conversation_id: ID }, handler: async (a) => ok(await canvas.put(`/conversations/${a.conversation_id}`, { conversation: { workflow_state: 'unread' } })) });
  tool({ name: 'star_conversation', group: H, write: true, description: 'Star a conversation.', schema: { conversation_id: ID }, handler: async (a) => ok(await canvas.put(`/conversations/${a.conversation_id}`, { conversation: { starred: true } })) });
  tool({ name: 'unstar_conversation', group: H, write: true, description: 'Unstar a conversation.', schema: { conversation_id: ID }, handler: async (a) => ok(await canvas.put(`/conversations/${a.conversation_id}`, { conversation: { starred: false } })) });
  tool({ name: 'archive_conversation', group: H, write: true, description: 'Archive a conversation, removing it from the inbox view.', schema: { conversation_id: ID }, handler: async (a) => ok(await canvas.put(`/conversations/${a.conversation_id}`, { conversation: { workflow_state: 'archived' } })) });
  tool({ name: 'delete_conversation', group: H, write: true, confirm: true, description: 'Delete a conversation from your inbox. This does not delete it for the other participants.', schema: { conversation_id: ID }, handler: async (a) => ok(await canvas.del(`/conversations/${a.conversation_id}`), 'Deleted.') });
  get({ name: 'get_unread_conversation_count', group: H, description: 'Number of unread Inbox messages. Very cheap.', path: '/conversations/unread_count' });
  tool({ name: 'batch_update_conversations', group: H, write: true, confirm: true, description: 'Apply one action (mark read, archive, star, destroy) to many conversations at once.', schema: { conversation_ids: z.array(z.string()), event: z.enum(['mark_as_read', 'mark_as_unread', 'star', 'unstar', 'archive', 'destroy']) }, handler: async (a) => ok(await canvas.put('/conversations', { conversation_ids: a.conversation_ids, event: a.event })) });
}
