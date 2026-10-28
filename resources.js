// Canvas items people can attach to a chat from their AI app's attach menu: course syllabi and upcoming
// assignments. Resources add no tools. Text other people wrote is fenced, like tool output.
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

const DAY = 86400000;

/**
 * deps: canvas (the Canvas client), html2text, fence, and ready() which is false while the token or address
 * is missing, so listing returns nothing instead of an error.
 */
export function registerResources(server, { canvas, html2text, fence, ready }) {
  const activeCourses = () => canvas.paginate('/courses', { enrollment_state: 'active' }, { max: 60, ttl: 60000 });

  server.registerResource(
    'syllabus',
    new ResourceTemplate('canvas://courses/{course_id}/syllabus', {
      list: async () => {
        if (!ready()) return { resources: [] };
        const courses = await activeCourses().catch(() => []);
        return {
          resources: courses.map((c) => ({ uri: `canvas://courses/${c.id}/syllabus`, name: `Syllabus: ${c.name}`, mimeType: 'text/plain' })),
        };
      },
    }),
    { title: 'Course syllabus', description: 'The syllabus page of one of your courses, as text.', mimeType: 'text/plain' },
    async (uri, { course_id: id }) => {
      const c = await canvas.get(`/courses/${id}`, { include: ['syllabus_body'] });
      const body = c.syllabus_body
        ? fence(html2text(c.syllabus_body), `syllabus: ${c.name}`)
        : 'This course has no syllabus page. The syllabus may be an uploaded file; ask the assistant to look in the course files.';
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Syllabus for ${c.name}\n\n${body}` }] };
    },
  );

  server.registerResource(
    'assignment',
    new ResourceTemplate('canvas://courses/{course_id}/assignments/{assignment_id}', {
      list: async () => {
        if (!ready()) return { resources: [] };
        const start = new Date();
        const items = await canvas.paginate('/planner/items', {
          start_date: start.toISOString(),
          end_date: new Date(start.getTime() + 14 * DAY).toISOString(),
        }, { max: 100, ttl: 60000 }).catch(() => []);
        return {
          resources: items
            .filter((i) => i.plannable_type === 'assignment' && i.course_id)
            .map((i) => ({
              uri: `canvas://courses/${i.course_id}/assignments/${i.plannable_id}`,
              name: `${i.context_name ? `${i.context_name}: ` : ''}${i.plannable?.title || 'Assignment'}`,
              description: i.plannable?.due_at ? `Due ${new Date(i.plannable.due_at).toLocaleString()}` : undefined,
              mimeType: 'text/plain',
            })),
        };
      },
    }),
    { title: 'Assignment', description: 'One assignment with its instructions, due date, points and your submission status. Lists what is due in the next 14 days.', mimeType: 'text/plain' },
    async (uri, { course_id: courseId, assignment_id: assignmentId }) => {
      const a = await canvas.get(`/courses/${courseId}/assignments/${assignmentId}`, { include: ['submission'] });
      const s = a.submission || {};
      const status = s.workflow_state === 'graded' ? `graded: ${s.score ?? ''}${a.points_possible ? `/${a.points_possible}` : ''}`
        : s.submitted_at ? 'submitted, not graded yet' : s.missing ? 'missing' : 'not submitted';
      const lines = [
        `Assignment: ${a.name}`,
        `Due: ${a.due_at ? new Date(a.due_at).toLocaleString() : 'no due date'}`,
        `Points: ${a.points_possible ?? 'not set'}`,
        `Submit as: ${(a.submission_types || []).join(', ') || 'not set'}`,
        `Your status: ${status}`,
        `Link: ${a.html_url}`,
        '',
        a.description ? fence(html2text(a.description), `assignment: ${a.name}`) : 'No instructions were written for this assignment.',
      ];
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: lines.join('\n') }] };
    },
  );
}
