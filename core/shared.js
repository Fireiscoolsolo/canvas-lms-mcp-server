// Helpers and field lists used by more than one tool group: uploads, downloads and common Canvas fields.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CanvasError, fetchWithRetry, hostOf, refuseBlocked } from './canvas-client.js';

const TRANSFER_TIMEOUT_MS = 10 * 60000;

export const FIELDS = {
  COURSE_FIELDS: ['id', 'name', 'course_code', 'workflow_state', 'start_at', 'end_at', 'term', 'enrollments', 'total_students', 'time_zone', 'public_description'],
  ASSIGN_FIELDS: ['id', 'name', 'due_at', 'lock_at', 'unlock_at', 'points_possible', 'grading_type', 'submission_types', 'html_url', 'has_submitted_submissions', 'published', 'assignment_group_id', 'omit_from_final_grade', 'allowed_attempts', 'submission', 'score_statistics', 'is_quiz_assignment'],
  SUB_FIELDS: ['id', 'assignment_id', 'user_id', 'submitted_at', 'score', 'grade', 'entered_score', 'entered_grade', 'workflow_state', 'late', 'missing', 'excused', 'attempt', 'seconds_late', 'points_deducted', 'grade_matches_current_submission', 'submission_type', 'preview_url', 'html_url', 'attachments', 'rubric_assessment'],
  TOPIC_FIELDS: ['id', 'title', 'posted_at', 'last_reply_at', 'discussion_type', 'locked', 'pinned', 'require_initial_post', 'user_can_see_posts', 'discussion_subentry_count', 'read_state', 'unread_count', 'subscribed', 'html_url', 'assignment_id', 'is_announcement'],
  FILE_FIELDS: ['id', 'display_name', 'filename', 'content-type', 'size', 'url', 'created_at', 'updated_at', 'folder_id', 'locked_for_user', 'mime_class'],
};

/**
 * A file name that is safe to write: no folders, no characters Windows rejects, no leading dots, not empty.
 * Canvas display names are chosen by whoever uploaded the file, so they are never trusted as paths.
 */
export function safeFileName(name, fallback = 'download') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 180);
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned);
  return cleaned && !reserved ? cleaned : fallback;
}

/** True when `p` is `folder` or somewhere inside it. */
const isInside = (folder, p) => {
  const rel = path.relative(folder, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** Where a path really is after following links, even when its last parts don't exist yet. */
function realPath(p) {
  for (let known = p; ;) {
    try { return path.join(fs.realpathSync(known), path.relative(known, p)); } catch (e) {
      const up = path.dirname(known);
      if (e.code !== 'ENOENT' || up === known) return p;
      known = up;
    }
  }
}

/** Save without ever replacing another file: a different file gets " (1)" added, and the same bytes aren't saved twice. */
function writeNew(folder, name, data) {
  const { name: stem, ext } = path.parse(name);
  for (let n = 0; n < 1000; n++) {
    const dest = path.join(folder, n ? `${stem} (${n})${ext}` : name);
    try {
      fs.writeFileSync(dest, data, { flag: 'wx' });
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (fs.statSync(dest).size === data.length && fs.readFileSync(dest).equals(data)) return dest;
    }
  }
  throw new CanvasError(`There are already 1,000 files called ${name} in ${folder}.`);
}

// What an upload must never pick up, whoever asks: files that hold keys or sign-ins, and the folders that keep them.
// A block list, not an allow list, because schoolwork can be anywhere: Documents, Desktop, OneDrive.
const PRIVATE_NAMES = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|oauth-store\.json(\.tmp)?|login-history\.json|supervisor-state\.json|alerts-state\.json|claude_desktop_config\.json|ngrok\.yml|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|pfx|p12|ppk|kdbx))$/i;
const PRIVATE_FOLDERS = [
  '/.ssh/', '/.aws/', '/.azure/', '/.gnupg/', '/.kube/', '/.docker/', '/.mozilla/', '/.config/google-chrome/', '/.config/chromium/',
  '/.claude/', '/.codex/', '/.cursor/', '/.gemini/', '/.codeium/', '/.lmstudio/', '/.config/claude/',
  '/appdata/roaming/claude/', '/appdata/roaming/cursor/', '/appdata/roaming/code/user/', '/appdata/roaming/mozilla/',
  '/appdata/local/google/chrome/', '/appdata/local/microsoft/edge/', '/appdata/local/bravesoftware/',
  '/library/keychains/', '/library/application support/claude/', '/library/application support/code/user/',
  '/library/application support/google/chrome/', '/library/application support/firefox/', '/library/application support/microsoft edge/',
];

/** Default link to a saved file for apps on the same computer: a file:// resource link. */
export function localFileLink(abs, { name, mimeType, bytes } = {}) {
  return { type: 'resource_link', uri: pathToFileURL(abs).href, name: name || path.basename(abs), ...(mimeType ? { mimeType } : {}), ...(bytes ? { size: bytes } : {}), description: 'Saved on this computer' };
}
// Apps on the same computer can open a folder too; a remote link (see the Remote Edition) can only serve files.
localFileLink.folders = true;

export function createShared({ canvas, cfg, dates, fileLink = localFileLink, fetchImpl = fetch, privateDirs = [] }) {
  /** Refuse a file that holds keys, sign-ins or this server's own settings. Files saved to the download folder are fine. */
  function assertNotPrivate(abs) {
    const real = realPath(abs);
    const saved = cfg.downloadDir ? realPath(cfg.downloadDir) : null;
    const settings = privateDirs.some((d) => isInside(realPath(d), real)) && !(saved && isInside(saved, real));
    const looksPrivate = (p) => PRIVATE_NAMES.test(path.basename(p)) || PRIVATE_FOLDERS.some((f) => p.replace(/\\/g, '/').toLowerCase().includes(f));
    if (settings || looksPrivate(abs) || looksPrivate(real)) {
      throw new CanvasError(`Refused: ${path.basename(abs)} looks like a private file (keys, sign-ins or this server's settings), so it won't be uploaded to Canvas. Nothing was sent.`, { code: 'BLOCKED' });
    }
  }

  /** The folder to save into: the download folder or a folder inside it, even after following links. */
  function downloadFolder(dest) {
    const root = cfg.downloadDir;
    fs.mkdirSync(root, { recursive: true });
    const target = path.resolve(root, dest || '.');
    if (!isInside(root, target) || !isInside(realPath(root), realPath(target))) {
      throw new CanvasError(`Refused: files can only be saved in your download folder (${root}) or a folder inside it. To save somewhere else, change CANVAS_DOWNLOAD_DIR. Nothing was saved.`, { code: 'BLOCKED' });
    }
    fs.mkdirSync(target, { recursive: true });
    return target;
  }

  /** Canvas file upload is a 3-step handshake: request slot -> POST to storage -> confirm. */
  async function uploadFile(endpoint, filePath, extra = {}) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) throw new CanvasError(`File not found on the computer running this server (${os.hostname()}): ${abs}`);
    assertNotPrivate(abs);
    const stat = fs.statSync(abs);
    const name = path.basename(abs);
    // Says which step failed and on which host, never the full address: upload URLs carry signed parameters.
    const failedAt = (n, step, host, e) => new CanvasError(`Upload failed at step ${n} of 3 (${step} on ${host}): ${e.message}`, { status: e.status, code: e.code, attempts: e.attempts, host, step });

    // Nothing is submitted until the file is attached to a submission, so steps 1 and 2 are safe to repeat.
    let slot;
    try {
      slot = await canvas.post(endpoint, { name, size: stat.size, content_type: 'application/octet-stream', on_duplicate: 'rename', ...extra }, undefined, { repeatable: true });
    } catch (e) { throw failedAt(1, 'slot request', hostOf(cfg.base), e); }
    if (!slot?.upload_url) throw new CanvasError('Canvas did not return an upload URL. The assignment may not accept file uploads.');

    const bytes = fs.readFileSync(abs);
    const body = () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(slot.upload_params || {})) form.append(k, String(v));
      form.append('file', new Blob([bytes]), name);
      return form;
    };
    const storageHost = hostOf(slot.upload_url);
    let up;
    try {
      up = await fetchWithRetry(fetchImpl, slot.upload_url, () => ({ method: 'POST', body: body(), redirect: 'follow' }), { base: cfg.base, timeoutMs: TRANSFER_TIMEOUT_MS });
    } catch (e) { throw failedAt(2, 'storage upload', storageHost, e); }
    if (!up.ok) throw failedAt(2, 'storage upload', storageHost, { message: `the storage server answered HTTP ${up.status}.`, status: up.status });

    let confirmed = null;
    let confirmError = null;
    try { confirmed = await up.json(); } catch { /* some backends 3xx to a confirm URL */ }
    // Canvas says where to confirm. canvas.raw() refuses anything off Canvas, so the token can't follow storage elsewhere.
    const confirmUrl = confirmed?.location || up.headers.get('location') || up.url;
    if (!confirmed?.id && confirmUrl) { try { confirmed = (await canvas.raw('GET', confirmUrl)).data; } catch (e) { confirmError = e; } }
    if (!confirmed?.id && confirmError) throw failedAt(3, 'confirm', hostOf(confirmUrl), confirmError);
    if (!confirmed?.id) throw new CanvasError('Upload completed but Canvas did not confirm a file ID.');
    return confirmed;
  }

  async function assignmentPreview(a) {
    const asg = await canvas.get(`/courses/${a.course_id}/assignments/${a.assignment_id}`, { include: ['submission'] });
    return {
      course_id: a.course_id, assignment: asg.name, assignment_id: asg.id,
      due_at: asg.due_at, due_local: dates.localize(asg.due_at), due_in: dates.relativeDue(asg.due_at),
      points_possible: asg.points_possible,
      accepted_submission_types: asg.submission_types,
      allowed_attempts: asg.allowed_attempts,
      attempts_used: asg.submission?.attempt || 0,
      already_submitted_at: asg.submission?.submitted_at || null,
      will_be_late: asg.due_at ? new Date() > new Date(asg.due_at) : false,
    };
  }

  async function activeCourses(max = 40) {
    return canvas.paginate('/courses', { enrollment_state: 'active', include: ['term'] }, { max, ttl: 300000 });
  }

  /**
   * Fetch a file address Canvas gave us, with a timeout. Throws a readable error on failure. Only addresses on Canvas
   * get the token: files stored elsewhere carry their own signature, and that host has no business seeing the token.
   */
  async function fetchFile(url) {
    const onCanvas = canvas.isCanvasUrl(url);
    if (onCanvas) refuseBlocked('GET', url);
    const headers = onCanvas ? { Authorization: `Bearer ${cfg.token}` } : {};
    const res = await fetchWithRetry(fetchImpl, url, () => ({ headers }), { base: cfg.base, timeoutMs: TRANSFER_TIMEOUT_MS });
    if (!res.ok) throw new CanvasError(`Download failed (HTTP ${res.status}). The file may be locked, deleted, or no longer shared with you.`);
    return res;
  }

  /**
   * Download a Canvas file URL (sent with the token) into `dir`, or save `text` there instead.
   * Returns where it went plus a link the app can open.
   */
  async function saveDownload({ url, text, dir = cfg.downloadDir, name, contentType }) {
    const folder = downloadFolder(dir);
    const data = text !== undefined ? Buffer.from(text) : Buffer.from(await (await fetchFile(url)).arrayBuffer());
    const dest = writeNew(folder, safeFileName(name), data);
    const bytes = data.length;
    return { saved_to: dest, bytes, link: fileLink(dest, { name: path.basename(dest), mimeType: contentType, bytes }) };
  }

  /** A link to a folder of saved files, where the app can open folders (same computer only); otherwise null. */
  const folderLink = (dir, name) => (fileLink.folders ? { type: 'resource_link', uri: pathToFileURL(dir).href, name, description: 'Folder on this computer' } : null);

  return { uploadFile, assertNotPrivate, assignmentPreview, activeCourses, fetchFile, saveDownload, downloadFolder, folderLink };
}
