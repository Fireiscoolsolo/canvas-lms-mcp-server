// Ready-made prompts that appear in the AI app's prompt menu. Each one tells the assistant which tools to use,
// so students get a good result without knowing the tool names. Prompts add no tools.
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { z } from 'zod';

const say = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

/** listCourseNames: async () => string[] of active course names, used to autocomplete course arguments. */
export function registerPrompts(server, { listCourseNames }) {
  const suggestCourses = async (value) => {
    const names = await listCourseNames().catch(() => []);
    const v = String(value || '').toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(v)).slice(0, 20);
  };
  const course = (description) => completable(z.string().describe(description), suggestCourses);
  const optionalCourse = (description) => completable(z.string().optional().describe(description), suggestCourses);

  server.registerPrompt('plan_my_week', {
    title: 'Plan my week',
    description: 'A day-by-day plan for the next 7 days from your due dates, missing work and busy days.',
  }, () => say([
    'Plan my next 7 days of schoolwork.',
    '1. Use get_week_ahead for everything due, and list_missing_submissions for anything overdue.',
    '2. Use deadline_conflict_check to find days where several things are due at once.',
    '3. Give me a short day-by-day plan (today first). Put overdue work first, spread big assignments over several days, and give a rough time estimate for each item.',
    '4. End with the 3 most important things to do today.',
  ].join('\n')));

  server.registerPrompt('what_did_i_miss', {
    title: 'What did I miss?',
    description: 'New grades, announcements, messages and replies since a few days ago, grouped by course.',
    argsSchema: { days: z.string().optional().describe('How many days back to look. Default 3.') },
  }, ({ days }) => say([
    `Catch me up on the last ${Number(days) > 0 ? Number(days) : 3} days of Canvas.`,
    '1. Work out the date that many days ago and use diff_since_last_check with it.',
    '2. Use get_all_unread for unread messages, announcements and discussion replies.',
    '3. Summarize by course: new grades (with the score), announcements (only the key information), messages I should reply to, and anything due in the next 3 days.',
    'Keep it brief and skip courses with nothing new.',
  ].join('\n')));

  server.registerPrompt('exam_prep', {
    title: 'Prep me for an exam',
    description: 'Works out what an exam covers, reads the course material and gives you a summary, practice questions and a study schedule.',
    argsSchema: {
      course: course('The course the exam is in'),
      exam: z.string().optional().describe('Which exam or topic, e.g. "Midterm 2". Leave empty for the next exam.'),
    },
  }, ({ course: c, exam }) => say([
    `Help me prepare for ${exam ? `"${exam}"` : 'my next exam'} in ${c}.`,
    '1. Find the course with list_courses.',
    '2. Use syllabus_digest, list_modules and list_upcoming_assignments to find the exam date and which modules or chapters it covers.',
    '3. Read the most relevant material: lecture files with read_course_file and pages with get_page_content.',
    '4. Give me: a one-page summary of the key ideas, 10 practice questions with the answers at the very end, and a study schedule from today until the exam.',
    'Only use what is in the course material, and tell me which files or pages each part came from.',
  ].join('\n')));

  server.registerPrompt('grade_check', {
    title: 'How are my grades?',
    description: 'Your grades, GPA, what is pulling them down and what you need on upcoming work.',
    argsSchema: { course: optionalCourse('Focus on one course. Leave empty for all courses.') },
  }, ({ course: c }) => say(c ? [
    `How am I doing in ${c}?`,
    '1. Find the course with list_courses, then use get_course_grade_breakdown.',
    '2. Use grade_impact_ranking to show which missing or low assignments hurt the most.',
    '3. Use compute_needed_score to tell me what I need on the remaining work to get an A and a B.',
    'Keep it short and end with the single most useful thing I can do to raise this grade.',
  ].join('\n') : [
    'How are my grades overall?',
    '1. Use get_all_grades for every course, and calculate_gpa for my current GPA.',
    '2. Use grade_impact_ranking to find the assignments hurting my grades the most.',
    '3. Show a short table (course, grade, trend if you can tell) and list the top 3 things that would raise my grades fastest.',
  ].join('\n')));

  server.registerPrompt('catch_up_on_course', {
    title: 'Catch me up on a course',
    description: 'Recent announcements, activity, upcoming and missing work for one course, and what to do next.',
    argsSchema: { course: course('The course to catch up on') },
  }, ({ course: c }) => say([
    `Catch me up on ${c}.`,
    '1. Find the course with list_courses.',
    '2. Use list_announcements and get_course_activity_stream for what happened recently.',
    '3. Use list_upcoming_assignments and list_missing_submissions for what is due and what I missed.',
    '4. Use list_modules to see where the class is in the material.',
    'Summarize what is going on in a few lines, then give me a short to-do list in order of urgency.',
  ].join('\n')));
}
