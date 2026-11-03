// Courses. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';

export default function register(ctx) {
  const { tool, get, canvas, ok, fence, html2text, COURSE, LIMIT, COURSE_FIELDS, omitEmpty, friendly } = ctx;

  const B = 'courses';

  get({
    name: 'list_courses', group: B,
    description: 'List courses you are enrolled in. By default only active ones; pass include_concluded to see finished terms. Includes current grade when available.',
    path: '/courses',
    schema: { include_concluded: z.boolean().optional(), include_grades: z.boolean().optional().describe('Default true'), limit: LIMIT },
    params: (a) => ({
      enrollment_state: a.include_concluded ? undefined : 'active',
      state: a.include_concluded ? ['available', 'completed'] : undefined,
      include: ['term', 'course_image', ...(a.include_grades === false ? [] : ['total_scores'])],
    }),
    paginate: true, max: 100, fields: COURSE_FIELDS,
  });
  get({ name: 'get_course', group: B, description: 'Full detail for one course including term, syllabus and public description.', path: (a) => `/courses/${a.course_id}`, schema: { course_id: COURSE }, params: () => ({ include: ['term', 'syllabus_body', 'public_description', 'course_image', 'total_scores'] }), fenceFields: ['syllabus_body', 'public_description'] });
  tool({
    name: 'get_syllabus', group: B,
    description: 'Fetch a course syllabus as readable text (Canvas stores it as HTML).',
    schema: { course_id: COURSE },
    handler: async (a) => {
      const c = await canvas.get(`/courses/${a.course_id}`, { include: ['syllabus_body'] });
      if (!c.syllabus_body) return ok({ course: c.name, syllabus: null, note: 'No syllabus body set on this course. The instructor may have uploaded a file instead. Try list_course_files.' });
      return ok({ course: c.name, syllabus: fence(html2text(c.syllabus_body), 'syllabus') });
    },
  });
  get({ name: 'get_course_settings', group: B, description: 'Course-level settings (late policy visibility, syllabus public, hide final grades, grading standard toggles).', path: (a) => `/courses/${a.course_id}/settings`, schema: { course_id: COURSE } });
  get({ name: 'list_course_tabs', group: B, description: 'Which navigation tabs exist and are visible in a course. Tells you if Quizzes/Files/Pages are even enabled before you query them.', path: (a) => `/courses/${a.course_id}/tabs`, schema: { course_id: COURSE } });
  get({ name: 'get_course_activity_stream', group: B, description: 'Recent activity scoped to a single course.', path: (a) => `/courses/${a.course_id}/activity_stream`, schema: { course_id: COURSE, limit: LIMIT }, paginate: true, max: 50, fenceFields: ['message', 'title'] });
  get({ name: 'list_sections', group: B, description: 'Sections within a course, including your own enrollment section.', path: (a) => `/courses/${a.course_id}/sections`, schema: { course_id: COURSE }, paginate: true });
  get({ name: 'list_course_users', group: B, comments: true, description: 'People in a course. Visibility depends on institution privacy settings; often limited or blocked for student tokens.', path: (a) => `/courses/${a.course_id}/users`, schema: { course_id: COURSE, enrollment_type: z.array(z.string()).optional().describe('student, teacher, ta, observer, designer'), search_term: z.string().optional(), limit: LIMIT }, params: (a) => ({ enrollment_type: a.enrollment_type, search_term: a.search_term, include: ['enrollments', 'avatar_url'] }), paginate: true, max: 100 });
  get({ name: 'get_user_in_course', group: B, comments: true, description: 'Details for one user within a course context.', path: (a) => `/courses/${a.course_id}/users/${a.user_id || 'self'}`, schema: { course_id: COURSE, user_id: z.string().optional().describe("Defaults to 'self'") }, params: () => ({ include: ['enrollments', 'bio'] }) });
  get({ name: 'get_course_permissions', group: B, description: 'What your token is actually allowed to do in this course. Call this before attempting any write to avoid half-completed actions.', path: (a) => `/courses/${a.course_id}/permissions`, schema: { course_id: COURSE } });
  get({ name: 'list_course_nicknames', group: B, description: 'Personal nicknames you have set for courses (only you see these).', path: '/users/self/course_nicknames', paginate: true });
  tool({ name: 'set_course_nickname', group: B, write: true, description: 'Rename a course for yourself only. Does not affect anyone else.', schema: { course_id: COURSE, nickname: z.string() }, handler: async (a) => ok(await canvas.put(`/users/self/course_nicknames/${a.course_id}`, { nickname: a.nickname })) });
  tool({ name: 'remove_course_nickname', group: B, write: true, description: 'Remove a personal course nickname, restoring the official name.', schema: { course_id: COURSE }, handler: async (a) => ok(await canvas.del(`/users/self/course_nicknames/${a.course_id}`)) });
  get({ name: 'get_course_progress', group: B, description: 'Module completion progress for self-paced courses. Returns 404 if the course has no module requirements.', path: (a) => `/courses/${a.course_id}/users/self/progress`, schema: { course_id: COURSE } });
  get({ name: 'list_todo_for_course', group: B, description: 'TODO items scoped to one course.', path: (a) => `/courses/${a.course_id}/todo`, schema: { course_id: COURSE }, paginate: true });
  get({ name: 'list_blackout_dates', group: B, description: 'Blackout dates for a course (no-work days used by course pacing).', path: (a) => `/courses/${a.course_id}/blackout_dates`, schema: { course_id: COURSE } });

  tool({
    name: 'course_contacts', group: B,
    description: 'Who to contact in a course and when: the teachers and TAs (with the user IDs send_message needs), office hours found in the syllabus, and office-hour or advising sign-up slots. Read-only.',
    schema: { course_id: COURSE },
    handler: async (a) => {
      const course = await canvas.get(`/courses/${a.course_id}`, { include: ['syllabus_body'] });
      const staff = await canvas.paginate(`/courses/${a.course_id}/users`, { enrollment_type: ['teacher', 'ta'], include: ['enrollments', 'email'] }, { max: 50 })
        .catch((e) => (e.status === 403 || e.status === 401 ? null : Promise.reject(e)));
      const text = course.syllabus_body ? html2text(course.syllabus_body) : '';
      const lines = text.split('\n');
      const officeHours = [];
      lines.forEach((l, i) => {
        if (/office hours?|student hours|drop-?in hours/i.test(l)) officeHours.push(lines.slice(i, i + 3).join(' ').replace(/\s+/g, ' ').trim());
      });
      const slots = await canvas.paginate('/appointment_groups', { scope: 'reservable', context_codes: [`course_${a.course_id}`], include: ['appointments'] }, { max: 30 }).catch(() => []);
      return ok(omitEmpty({
        course: course.name,
        teachers_and_tas: staff === null ? 'Your school hides the class list from students. Use find_recipients with this course to look someone up by name.'
          : staff.map((u) => omitEmpty({
            user_id: u.id, name: u.name,
            role: [...new Set((u.enrollments || []).map((e) => (e.type === 'TeacherEnrollment' ? 'teacher' : e.type === 'TaEnrollment' ? 'TA' : e.role)).filter(Boolean))].join(', ') || undefined,
            email: u.email,
          })),
        office_hours_from_syllabus: officeHours.length ? officeHours.slice(0, 6).map((t) => fence(t, 'syllabus: office hours')) : (text ? 'The syllabus does not mention office hours.' : 'This course has no syllabus page. The syllabus may be an uploaded file; look in list_course_files.'),
        sign_up_slots: slots.map((g) => omitEmpty({
          appointment_group_id: g.id, title: g.title, location: g.location_name,
          open_slots: (g.appointments || []).filter((s) => new Date(s.start_at) > new Date() && (s.available_slots === undefined || s.available_slots > 0)).length,
          next_slot: friendly((g.appointments || []).map((s) => s.start_at).filter((t) => new Date(t) > new Date()).sort()[0]),
        })),
        how_to_reach_them: 'Message a teacher with send_message (recipient = their user_id, course_id = this course). Book a sign-up slot with get_appointment_group, then reserve_appointment_slot.',
      }));
    },
  });
}
