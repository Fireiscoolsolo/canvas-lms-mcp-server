// Tool profiles: named sets of tools, picked with CANVAS_PROFILE by name or number. Some AI apps can only handle so
// many tools (VS Code stops at 128 in one request) and small local models get lost in a long list, so a profile turns
// on just what a student needs for one kind of work. This list is the only place profiles are defined.
//
// The numbers and names are in people's settings files, so they must never change once released.
//   tools   the tool names it turns on, or 'all'
//   writes  false = nothing in it can change Canvas, whatever CANVAS_ALLOW_WRITES says

const ALWAYS = ['search_tools', 'test_connection', 'get_server_config'];

export const PROFILES = Object.freeze([
  {
    number: 1, id: 'essentials', title: 'Essentials', writes: false,
    summary: 'The daily basics: what\'s due, your grades, announcements and reading an assignment. Nothing here changes Canvas. Best for small local models.',
    tools: [
      ...ALWAYS, 'list_courses', 'get_syllabus', 'list_upcoming_assignments', 'list_missing_submissions', 'get_assignment',
      'assignment_brief', 'get_my_submission', 'list_submission_comments', 'get_all_grades', 'get_course_grade_breakdown',
      'compute_needed_score', 'list_announcements', 'list_conversations', 'get_conversation', 'list_modules',
      'list_module_items', 'get_page_content', 'read_course_file', 'daily_briefing', 'get_week_ahead', 'get_all_unread',
    ],
  },
  {
    number: 2, id: 'core', title: 'Core', writes: true,
    summary: 'A bit of everything, including turning in work and sending messages.',
    tools: [
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
    ],
  },
  {
    number: 3, id: 'study', title: 'Study and planning', writes: true,
    summary: 'Planning your week and studying: planner, calendar, study plans, course files and pages.',
    tools: [
      ...ALWAYS, 'list_courses', 'get_syllabus', 'list_upcoming_assignments', 'list_missing_submissions', 'get_assignment',
      'assignment_brief', 'list_modules', 'list_module_items', 'mark_module_item_done', 'list_pages', 'get_page_content',
      'list_course_files', 'read_course_file', 'get_media_captions', 'search_course_content', 'list_calendar_events',
      'create_personal_event', 'list_planner_items', 'list_planner_notes', 'create_planner_note', 'update_planner_note',
      'delete_planner_note', 'mark_planner_item_done', 'export_deadlines_ics', 'daily_briefing', 'study_plan',
      'schedule_study_plan', 'get_week_ahead', 'get_workload_forecast', 'deadline_conflict_check', 'study_priority_ranking',
      'syllabus_digest', 'list_announcements',
    ],
  },
  {
    number: 4, id: 'grades', title: 'Grades and feedback', writes: true,
    summary: 'Grades and feedback: scores, what-if, what you need on the final, rubrics and comments.',
    tools: [
      ...ALWAYS, 'list_courses', 'list_assignments', 'get_assignment', 'list_assignment_groups', 'get_late_policy',
      'get_score_statistics', 'list_missing_submissions', 'get_my_submission', 'list_my_submissions', 'get_submission_history',
      'get_rubric_assessment', 'list_submission_comments', 'get_all_grades', 'calculate_gpa', 'get_course_grade_breakdown',
      'what_if_grade', 'reset_what_if_grades', 'get_grading_standard', 'list_grading_periods', 'compute_needed_score',
      'grade_impact_ranking', 'get_grade_trend', 'final_grade_scenarios', 'get_rubric', 'get_my_rubric_assessment',
      'course_health_check', 'semester_snapshot', 'recent_feedback',
    ],
  },
  {
    number: 5, id: 'readonly', title: 'Read only', writes: false, tools: 'all',
    summary: 'Everything that only looks. Nothing in Canvas can change.',
  },
  {
    number: 6, id: 'full', title: 'Everything', writes: true, tools: 'all',
    summary: 'Every tool. The default.',
  },
].map((p) => Object.freeze({ ...p, tools: Array.isArray(p.tools) ? Object.freeze(p.tools) : p.tools })));

/** Used when CANVAS_PROFILE is not set. */
export const DEFAULT_PROFILE = 'full';
/** Used when CANVAS_PROFILE is set to something nobody can read: the smaller set, never everything. */
export const FALLBACK_PROFILE = 'core';

/** Never really set. An app that can't fill in a setting can leave its ${placeholder} behind. */
export const isUnset = (v) => !String(v ?? '').trim() || /^\$\{.*\}$/.test(String(v).trim());

export const profileById = (id) => PROFILES.find((p) => p.id === id) || null;

/**
 * The profile a CANVAS_PROFILE value means: exactly one name or one number written as plain digits, in any case and
 * with stray spaces. Not set means everything. Anything else, such as "02", "2.0" or "study,grades", is null.
 */
export function resolveProfile(value) {
  if (isUnset(value)) return profileById(DEFAULT_PROFILE);
  const v = String(value).trim().toLowerCase();
  return PROFILES.find((p) => p.id === v || (/^[1-9][0-9]*$/.test(v) && p.number === Number(v))) || null;
}

/** Whether a profile turns this tool on. A profile that can't change Canvas never includes a tool that does. */
export const profileIncludes = (profile, { name, write }) => (profile.tools === 'all' || profile.tools.includes(name)) && (profile.writes || !write);

/** "1 essentials, 2 core, …" for messages. */
export const profileChoices = () => PROFILES.map((p) => `${p.number} ${p.id}`).join(', ');
