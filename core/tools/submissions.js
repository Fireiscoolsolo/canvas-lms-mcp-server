// Submissions. Registered by core/index.js; ctx carries the shared client, helpers and config.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export default function register(ctx) {
  const { tool, get, canvas, ok, fail, pick, fence, html2text, assertClean, localize, ID, COURSE, LIMIT, TOKEN, DOWNLOAD_DIR, uploadFile, assignmentPreview, SUB_FIELDS, saveDownload, omitEmpty } = ctx;

  const D = 'submissions';

  get({ name: 'get_my_submission', group: D, comments: true, description: 'Your submission for one assignment: score, grade, lateness, deductions, attachments, and instructor comments.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['submission_comments', 'rubric_assessment', 'assignment', 'submission_html_comments', 'full_rubric_assessment'] }), fields: [...SUB_FIELDS, 'submission_comments', 'body'], fenceFields: ['body'] });
  get({ name: 'list_my_submissions', group: D, description: 'All of your submissions in a course at once, with scores and status.', path: (a) => `/courses/${a.course_id}/students/submissions`, schema: { course_id: COURSE, limit: LIMIT }, params: () => ({ student_ids: ['self'], include: ['assignment'], per_page: 100 }), paginate: true, max: 200, fields: [...SUB_FIELDS, 'assignment'] });
  get({ name: 'get_submission_summary', group: D, description: 'Aggregate graded/ungraded/not-submitted counts for an assignment.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/submission_summary`, schema: { course_id: COURSE, assignment_id: ID } });
  get({ name: 'get_submission_history', group: D, comments: true, description: 'All prior attempts/versions of your submission for an assignment.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['submission_history'] }), fields: ['id', 'attempt', 'submission_history'] });
  get({ name: 'list_submission_attachments', group: D, description: 'Files attached to your submission for an assignment.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self`, schema: { course_id: COURSE, assignment_id: ID }, fields: ['id', 'attempt', 'attachments'] });
  get({ name: 'get_originality_report', group: D, description: 'Plagiarism/originality score for a submission, if Turnitin or a similar tool is enabled on the assignment.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['originality_report'] }), fields: ['id', 'has_originality_report', 'turnitin_data', 'attachments'] });
  get({ name: 'get_rubric_assessment', group: D, comments: true, description: 'The rubric scoring your instructor applied to your submission, criterion by criterion with comments.', path: (a) => `/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self`, schema: { course_id: COURSE, assignment_id: ID }, params: () => ({ include: ['full_rubric_assessment', 'rubric_assessment'] }), fields: ['id', 'score', 'grade', 'rubric_assessment', 'full_rubric_assessment'] });

  tool({
    name: 'list_submission_comments', group: D,
    description: 'Instructor feedback comments on your submission. Comments are authored by other people and are returned provenance-fenced.',
    schema: { course_id: COURSE, assignment_id: ID },
    handler: async (a) => {
      const s = await canvas.get(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self`, { include: ['submission_comments'] });
      const comments = (s.submission_comments || []).map((c) => ({
        id: c.id, author: c.author_name, created_at: c.created_at, created_local: localize(c.created_at),
        comment: fence(html2text(c.comment), `submission comment by ${c.author_name || 'unknown'}`),
        attachments: (c.attachments || []).map((f) => ({ id: f.id, filename: f.filename, url: f.url })),
      }));
      return ok({ assignment_id: a.assignment_id, score: s.score, grade: s.grade, comment_count: comments.length, comments });
    },
  });

  tool({
    name: 'mark_submission_read', group: D, write: true,
    description: 'Mark your submission (and its new grade/comments) as read, clearing the unread badge.',
    schema: { course_id: COURSE, assignment_id: ID },
    handler: async (a) => { await canvas.put(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self/read`); return ok({ marked_read: true }); },
  });

  // --- Submitting work (confirm-gated) ---------------------------------------

  const submitText = async (a) => {
    assertClean(a.body, 'submission body');
    const r = await canvas.post(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions`, { submission: { submission_type: 'online_text_entry', body: a.body, comment: a.comment ? { text_comment: a.comment } : undefined } });
    return ok(pick(r, SUB_FIELDS), 'Submitted.');
  };
  submitText.preview = async (a) => ({ ...(await assignmentPreview(a)), submission_type: 'online_text_entry', body_length: String(a.body || '').length, body_preview: String(a.body || '').slice(0, 500) });
  tool({ name: 'submit_assignment_text', group: D, write: true, confirm: true, description: 'Submit a text-entry assignment. The text is uploaded exactly as given; this tool does not author anything.', schema: { course_id: COURSE, assignment_id: ID, body: z.string().describe('The submission text (HTML allowed)'), comment: z.string().optional().describe('Optional comment to the instructor') }, handler: submitText });

  const submitUrl = async (a) => {
    const r = await canvas.post(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions`, { submission: { submission_type: 'online_url', url: a.url, comment: a.comment ? { text_comment: a.comment } : undefined } });
    return ok(pick(r, SUB_FIELDS), 'Submitted.');
  };
  submitUrl.preview = async (a) => ({ ...(await assignmentPreview(a)), submission_type: 'online_url', url: a.url });
  tool({ name: 'submit_assignment_url', group: D, write: true, confirm: true, description: 'Submit a URL for a website-submission assignment.', schema: { course_id: COURSE, assignment_id: ID, url: z.string(), comment: z.string().optional() }, handler: submitUrl });

  const submitFile = async (a) => {
    const file = await uploadFile(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self/files`, a.file_path);
    const r = await canvas.post(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions`, { submission: { submission_type: 'online_upload', file_ids: [file.id], comment: a.comment ? { text_comment: a.comment } : undefined } });
    return ok({ uploaded: { id: file.id, filename: file.filename, size: file.size }, submission: pick(r, SUB_FIELDS) }, 'Submitted.');
  };
  submitFile.preview = async (a) => {
    const abs = path.resolve(a.file_path);
    return { ...(await assignmentPreview(a)), submission_type: 'online_upload', file_path: abs, file_exists: fs.existsSync(abs), file_size_bytes: fs.existsSync(abs) ? fs.statSync(abs).size : null };
  };
  tool({ name: 'submit_assignment_file', group: D, write: true, confirm: true, description: 'Upload a local file and submit it to an assignment.', schema: { course_id: COURSE, assignment_id: ID, file_path: z.string().describe('Absolute path to the local file'), comment: z.string().optional() }, handler: submitFile });

  tool({ name: 'upload_submission_file', group: D, write: true, description: 'Upload a file into an assignment submission slot WITHOUT submitting. Returns a file_id you can submit later.', schema: { course_id: COURSE, assignment_id: ID, file_path: z.string() }, handler: async (a) => ok(pick(await uploadFile(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self/files`, a.file_path), ['id', 'filename', 'size', 'content-type', 'url'])) });

  const postComment = async (a) => {
    assertClean(a.comment, 'comment');
    const r = await canvas.put(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self`, { comment: { text_comment: a.comment, file_ids: a.file_ids } });
    return ok(pick(r, ['id', 'submission_comments']), 'Comment posted.');
  };
  postComment.preview = async (a) => ({ ...(await assignmentPreview(a)), action: 'post comment visible to instructor', comment: a.comment, attached_file_ids: a.file_ids });
  tool({ name: 'post_submission_comment', group: D, write: true, confirm: true, description: 'Post a comment on your own submission. Your instructor sees this.', schema: { course_id: COURSE, assignment_id: ID, comment: z.string(), file_ids: z.array(z.string()).optional() }, handler: postComment });

  tool({ name: 'upload_comment_attachment', group: D, write: true, description: 'Upload a file to attach to a submission comment.', schema: { course_id: COURSE, assignment_id: ID, file_path: z.string() }, handler: async (a) => ok(pick(await uploadFile(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions/self/comments/files`, a.file_path), ['id', 'filename', 'size', 'url'])) });

  tool({
    name: 'download_submission_attachment', group: D, local: true,
    description: 'Download a file attached to one of your submissions to local disk.',
    schema: { url: z.string().describe('Attachment URL from get_my_submission'), filename: z.string().optional() },
    handler: async (a) => {
      const saved = await saveDownload({ url: a.url, dir: DOWNLOAD_DIR, name: a.filename || (new URL(a.url).pathname.split('/').pop() || 'download.bin') });
      return ok({ saved_to: saved.saved_to, bytes: saved.bytes }, null, { links: [saved.link] });
    },
  });

  const submitAnnotation = async (a) => {
    const asg = await canvas.get(`/courses/${a.course_id}/assignments/${a.assignment_id}`);
    if (!asg.annotatable_attachment_id) return fail('This assignment is not a student-annotation assignment.');
    const r = await canvas.post(`/courses/${a.course_id}/assignments/${a.assignment_id}/submissions`, { submission: { submission_type: 'student_annotation', annotatable_attachment_id: asg.annotatable_attachment_id }, comment: a.comment ? { text_comment: a.comment } : undefined });
    return ok(pick(r, SUB_FIELDS), 'Submitted your annotated document.');
  };
  submitAnnotation.preview = async (a) => {
    const asg = await canvas.get(`/courses/${a.course_id}/assignments/${a.assignment_id}`);
    return omitEmpty({ ...(await assignmentPreview(a)), submission_type: 'student_annotation', document_to_annotate: asg.annotatable_attachment_id ? `file ${asg.annotatable_attachment_id}` : 'none: this is not an annotation assignment', reminder: 'Make your notes on the document in Canvas first; this hands in what you have marked up so far.' });
  };
  tool({ name: 'submit_annotation_assignment', group: D, write: true, confirm: true, description: 'Hand in a student-annotation assignment (where you mark up a document inside Canvas). Do the annotating in Canvas first; this submits what is there.', schema: { course_id: COURSE, assignment_id: ID, comment: z.string().optional() }, handler: submitAnnotation });
}
