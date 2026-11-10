// Ready-made prompts that appear in the AI app's prompt menu. Each one tells the assistant which tools to use,
// so students get a good result without knowing the tool names. Prompts add no tools.
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { z } from 'zod';

const say = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

/**
 * listCourseNames: async () => string[] of active course names, used to autocomplete course arguments.
 * isOn: (toolName) => whether that tool is registered. A prompt only shows up when every tool it names is on, so a
 * smaller profile never offers a prompt that sends the AI looking for a tool it doesn't have.
 * Returns [{ name, needs, on }] for every prompt.
 */
export function registerPrompts(server, { listCourseNames, isOn = () => true }) {
  const list = [];
  const prompt = (name, needs, config, cb) => {
    const on = needs.every(isOn);
    list.push({ name, needs, on });
    if (on) server.registerPrompt(name, config, cb);
  };
  const suggestCourses = async (value) => {
    const names = await listCourseNames().catch(() => []);
    const v = String(value || '').toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(v)).slice(0, 20);
  };
  const course = (description) => completable(z.string().describe(description), suggestCourses);
  const optionalCourse = (description) => completable(z.string().optional().describe(description), suggestCourses);

  prompt('plan_my_week', ['get_week_ahead', 'list_missing_submissions', 'deadline_conflict_check'], {
    title: 'Plan my week',
    description: 'A day-by-day plan for the next 7 days from your due dates, missing work and busy days.',
  }, () => say([
    'Plan my next 7 days of schoolwork.',
    '1. Use get_week_ahead for everything due, and list_missing_submissions for anything overdue.',
    '2. Use deadline_conflict_check to find days where several things are due at once.',
    '3. Give me a short day-by-day plan (today first). Put overdue work first, spread big assignments over several days, and give a rough time estimate for each item.',
    '4. End with the 3 most important things to do today.',
  ].join('\n')));

  prompt('what_did_i_miss', ['diff_since_last_check', 'get_all_unread'], {
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

  prompt('exam_prep', ['list_courses', 'syllabus_digest', 'list_modules', 'list_upcoming_assignments', 'read_course_file', 'get_page_content'], {
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

  prompt('grade_check', ['list_courses', 'get_course_grade_breakdown', 'grade_impact_ranking', 'compute_needed_score', 'get_all_grades', 'calculate_gpa'], {
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

  prompt('catch_up_on_course', ['list_courses', 'list_announcements', 'get_course_activity_stream', 'list_upcoming_assignments', 'list_missing_submissions', 'list_modules'], {
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

  prompt('daily_briefing', ['daily_briefing'], {
    title: 'Daily briefing',
    description: 'Today at a glance: classes, what is due today and tomorrow, new grades and anything you should read.',
  }, () => say([
    'Give me my Canvas briefing for today.',
    '1. Use daily_briefing.',
    '2. Lead with anything due today, then tomorrow, with the time each is due.',
    '3. Mention new grades (with the score), unread announcements worth reading, and how many unread messages I have.',
    '4. If there is missing work, list it and say which piece to do first.',
    'Keep it short enough to read in 30 seconds.',
  ].join('\n')));

  prompt('plan_study_blocks', ['study_plan', 'schedule_study_plan'], {
    title: 'Plan my study blocks',
    description: 'Study time blocks for the next two weeks, fitted around your calendar, that you can add to Canvas.',
    argsSchema: {
      hours: z.string().optional().describe('Study hours each day, e.g. "16:00-21:00". Default 4 pm to 9 pm.'),
      days: z.string().optional().describe('How many days ahead to plan. Default 14.'),
    },
  }, ({ hours, days }) => {
    const [start, end] = String(hours || '').split('-').map((s) => s.trim());
    return say([
      `Plan study blocks for the next ${Number(days) > 0 ? Number(days) : 14} days.`,
      `1. Use study_plan${start && end ? ` with day_start "${start}" and day_end "${end}"` : ''}.`,
      '2. Show the plan day by day with times, and point out anything that did not fit.',
      '3. Ask me whether to adjust anything (hours, days off, estimates).',
      '4. Once I agree, use schedule_study_plan to add the blocks to my Canvas calendar.',
    ].join('\n'));
  });

  prompt('start_assignment', ['list_courses', 'list_assignments', 'assignment_brief', 'read_course_file'], {
    title: 'Start this assignment',
    description: 'Everything about one assignment in plain words: what to do, how it is graded, what to submit and a plan to finish on time.',
    argsSchema: {
      course: course('The course the assignment is in'),
      assignment: z.string().describe('The assignment name, or part of it'),
    },
  }, ({ course: c, assignment }) => say([
    `Help me start "${assignment}" in ${c}.`,
    '1. Find the course with list_courses and the assignment with list_assignments (search_term helps).',
    '2. Use assignment_brief for the instructions, rubric, due date, late policy and linked files. Read linked files with read_course_file if they matter.',
    '3. Explain in plain words what I have to produce and how it will be graded, criterion by criterion.',
    '4. Give me a checklist of steps with a rough time for each, finishing before the due date.',
    'Do not write the assignment for me; help me understand and plan it.',
  ].join('\n')));

  prompt('on_track_to_pass', ['get_all_grades', 'list_missing_submissions', 'final_grade_scenarios'], {
    title: 'Am I on track to pass?',
    description: 'Checks every course for risk: current grades, missing work and what you need on the rest to pass.',
    argsSchema: { passing: z.string().optional().describe('The lowest passing percentage. Default 60.') },
  }, ({ passing }) => say([
    `Am I on track to pass all my courses (passing is ${Number(passing) > 0 ? Number(passing) : 60}%)?`,
    '1. Use get_all_grades and list_missing_submissions.',
    '2. For any course near or below passing, use final_grade_scenarios to see the average I need on the remaining work.',
    '3. Give me a table: course, current grade, missing items, needed average, and a verdict (safe, watch, at risk).',
    '4. For each at-risk course, list the two most useful things to do this week.',
  ].join('\n')));

  prompt('email_professor', ['list_courses', 'course_contacts', 'assignment_brief', 'get_my_submission', 'send_message'], {
    title: 'Draft an email to my professor',
    description: 'A short, polite Canvas message to a teacher about an extension, a grade question or anything else. You review it before anything is sent.',
    argsSchema: {
      course: course('The course'),
      about: z.string().describe('What the message is about, e.g. "asking for a 2-day extension on Lab 4 because I was sick"'),
    },
  }, ({ course: c, about }) => say([
    `Help me write a Canvas message to my teacher in ${c} about: ${about}`,
    '1. Find the course with list_courses and the teacher with course_contacts.',
    '2. If it is about an assignment or grade, look it up (assignment_brief or get_my_submission) so the message has the right names and dates.',
    '3. Draft a short, polite message: a clear subject, the request in the first two sentences, any context, and thanks.',
    '4. Show me the draft and wait. Only send it with send_message after I say it is good.',
  ].join('\n')));

  prompt('semester_wrap_up', ['semester_wrap_up', 'export_all_courses', 'download_all_course_files'], {
    title: 'Semester wrap-up',
    description: 'End-of-term checklist: final grades, anything still missing, and saving your course files before access ends.',
  }, () => say([
    'Help me wrap up the semester.',
    '1. Use semester_wrap_up for every course: grades, missing work, what is still due and when each course ends.',
    '2. List what I still need to finish, soonest course end first.',
    '3. Point out any grade that looks worth asking the teacher about.',
    '4. Offer to save copies of my courses with export_all_courses (or download_all_course_files for one course), and do it only if I say yes.',
  ].join('\n')));

  return list;
}
