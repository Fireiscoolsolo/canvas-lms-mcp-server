// Groups. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';

export default function register(ctx) {
  const { tool, get, canvas, ok, assertClean, ID, COURSE, LIMIT, TOPIC_FIELDS, FILE_FIELDS } = ctx;

  const K = 'groups';

  get({ name: 'list_my_groups', group: K, description: 'Student groups you belong to across all courses.', path: '/users/self/groups', schema: { limit: LIMIT }, paginate: true, fields: ['id', 'name', 'description', 'course_id', 'members_count', 'group_category_id', 'context_type'] });
  get({ name: 'get_group', group: K, description: 'Detail for one group.', path: (a) => `/groups/${a.group_id}`, schema: { group_id: ID }, fenceFields: ['description'] });
  get({ name: 'list_group_members', group: K, description: 'Members of a group.', path: (a) => `/groups/${a.group_id}/users`, schema: { group_id: ID }, paginate: true, fields: ['id', 'name', 'short_name'] });
  get({ name: 'list_group_discussions', group: K, description: 'Discussion topics inside a group workspace.', path: (a) => `/groups/${a.group_id}/discussion_topics`, schema: { group_id: ID, limit: LIMIT }, paginate: true, fields: TOPIC_FIELDS });
  get({ name: 'list_group_files', group: K, description: 'Files in a group workspace.', path: (a) => `/groups/${a.group_id}/files`, schema: { group_id: ID, limit: LIMIT }, paginate: true, fields: FILE_FIELDS });
  get({ name: 'list_group_pages', group: K, description: 'Wiki pages in a group workspace.', path: (a) => `/groups/${a.group_id}/pages`, schema: { group_id: ID }, paginate: true });
  const postGroup = async (a) => { assertClean(a.message, 'group post'); return ok(await canvas.post(`/groups/${a.group_id}/discussion_topics/${a.topic_id}/entries`, { message: a.message }), 'Posted.'); };
  postGroup.preview = async (a) => ({ action: 'POST to a group discussion', group_id: a.group_id, topic_id: a.topic_id, visible_to: 'everyone in the group', message: a.message });
  tool({ name: 'post_group_discussion', group: K, write: true, confirm: true, description: 'Post to a discussion inside a group workspace. Visible to your groupmates.', schema: { group_id: ID, topic_id: ID, message: z.string() }, handler: postGroup });
  get({ name: 'list_group_categories', group: K, description: 'Group categories/sets defined in a course.', path: (a) => `/courses/${a.course_id}/group_categories`, schema: { course_id: COURSE }, paginate: true });
  tool({ name: 'join_group', group: K, write: true, confirm: true, description: 'Join a self-signup group.', schema: { group_id: ID }, handler: async (a) => ok(await canvas.post(`/groups/${a.group_id}/memberships`, { user_id: 'self' }), 'Joined.') });
  tool({ name: 'leave_group', group: K, write: true, confirm: true, description: 'Leave a group you are a member of.', schema: { group_id: ID }, handler: async (a) => ok(await canvas.del(`/groups/${a.group_id}/users/self`), 'Left group.') });
  get({ name: 'get_group_activity_stream', group: K, description: 'Recent activity in a group workspace.', path: (a) => `/groups/${a.group_id}/activity_stream`, schema: { group_id: ID }, paginate: true, max: 30, fenceFields: ['message', 'title'] });
}
