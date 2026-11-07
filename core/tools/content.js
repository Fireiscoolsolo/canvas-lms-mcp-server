// Files and content. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';
import { extractFileText, MAX_FILE_BYTES } from '../file-text.js';

export default function register(ctx) {
  const { readFile, tool, get, canvas, ok, fail, pick, omitEmpty, fence, fenceProse, html2text, ID, COURSE, LIMIT, TOKEN, DOWNLOAD_DIR, uploadFile, filePreview, FILE_FIELDS, saveDownload, localize } = ctx;

  const J = 'content';

  get({ name: 'list_course_files', group: J, description: 'Files published in a course (slides, readings, handouts).', path: (a) => `/courses/${a.course_id}/files`, schema: { course_id: COURSE, search_term: z.string().optional(), content_types: z.array(z.string()).optional().describe('e.g. application/pdf'), limit: LIMIT }, params: (a) => ({ search_term: a.search_term, content_types: a.content_types, sort: 'created_at', order: 'desc' }), paginate: true, max: 200, fields: FILE_FIELDS });
  get({ name: 'list_folders', group: J, description: 'Folders in a course file tree.', path: (a) => `/courses/${a.course_id}/folders`, schema: { course_id: COURSE }, paginate: true, fields: ['id', 'name', 'full_name', 'parent_folder_id', 'files_count', 'folders_count', 'locked_for_user'] });
  get({ name: 'get_folder', group: J, description: 'Detail for one folder.', path: (a) => `/folders/${a.folder_id}`, schema: { folder_id: ID } });
  tool({
    name: 'get_folder_tree', group: J,
    description: 'Recursive folder+file tree for a course, rendered as an indented outline. Good first look at what material exists.',
    schema: { course_id: COURSE, max_depth: z.number().int().positive().optional() },
    handler: async (a) => {
      const folders = await canvas.paginate(`/courses/${a.course_id}/folders`, null, { max: 200 });
      const files = await canvas.paginate(`/courses/${a.course_id}/files`, null, { max: 400 });
      const byParent = new Map();
      for (const f of folders) { const k = String(f.parent_folder_id || 'root'); if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(f); }
      const filesByFolder = new Map();
      for (const f of files) { const k = String(f.folder_id); if (!filesByFolder.has(k)) filesByFolder.set(k, []); filesByFolder.get(k).push(f); }
      const lines = [];
      const walk = (parentKey, depth) => {
        if (depth > (a.max_depth || 6)) return;
        for (const f of byParent.get(parentKey) || []) {
          lines.push(`${'  '.repeat(depth)}[${f.name}]/  (${f.files_count} files)`);
          for (const file of filesByFolder.get(String(f.id)) || []) lines.push(`${'  '.repeat(depth + 1)}${file.display_name}  (${Math.round((file.size || 0) / 1024)}kb, id=${file.id})`);
          walk(String(f.id), depth + 1);
        }
      };
      walk('root', 0);
      const rootless = folders.filter((f) => !f.parent_folder_id);
      if (!lines.length && rootless.length) for (const f of rootless) lines.push(`[${f.name}]/`);
      return ok(lines.join('\n') || 'No files or folders visible in this course.');
    },
  });
  get({ name: 'get_file_metadata', group: J, description: 'Metadata for one file.', path: (a) => `/files/${a.file_id}`, schema: { file_id: ID }, fields: FILE_FIELDS });
  get({ name: 'get_file_public_url', group: J, description: 'Get a temporary public download URL for a file.', path: (a) => `/files/${a.file_id}/public_url`, schema: { file_id: ID } });

  tool({
    name: 'download_file', group: J, local: true,
    description: 'Download a Canvas file to local disk.',
    schema: { file_id: ID, dest_dir: z.string().optional() },
    handler: async (a) => {
      const meta = await canvas.get(`/files/${a.file_id}`);
      const saved = await saveDownload({ url: meta.url, dir: a.dest_dir || DOWNLOAD_DIR, name: meta.display_name || meta.filename || `file-${a.file_id}`, contentType: meta['content-type'] });
      return ok({ saved_to: saved.saved_to, bytes: saved.bytes, content_type: meta['content-type'] }, null, { links: [saved.link] });
    },
  });

  tool({
    name: 'read_course_file', group: J,
    description: 'Read the text of a course file (PDF, Word, PowerPoint or plain text) so it can be summarized or studied.',
    schema: {
      file_id: ID,
      offset: z.number().int().min(0).optional(),
      max_chars: z.number().int().positive().optional(),
    },
    handler: async (a) => {
      const meta = await canvas.get(`/files/${a.file_id}`);
      const name = meta.display_name || meta.filename || `file-${a.file_id}`;
      if (meta.size > MAX_FILE_BYTES) return fail(`"${name}" is ${Math.round(meta.size / 1048576)} MB, which is too big to read here (limit 25 MB). Use download_file to save it instead.`);
      const bytes = await readFile(meta.url, MAX_FILE_BYTES, `"${name}"`);
      let extracted;
      try {
        extracted = await extractFileText(bytes, { name, contentType: meta['content-type'], html2text });
      } catch (e) {
        return fail(e.message);
      }
      const text = extracted.text.replace(/[ \t]+\n/g, '\n').trim();
      const hasWords = /[A-Za-z0-9]{3}/.test(text.replace(/--- (Page|Slide) \d+ ---/g, ''));
      const start = Math.min(a.offset || 0, text.length);
      const chunk = text.slice(start, start + Math.min(a.max_chars || 30000, 100000));
      const next = start + chunk.length < text.length ? start + chunk.length : null;
      return ok(omitEmpty({
        file: name, kind: extracted.kind, total_chars: text.length, offset: start, next_offset: next,
        note: !hasWords ? 'No readable text found. This is probably a scanned document (pictures of pages), which needs OCR.'
          : next !== null ? `Showing characters ${start}-${start + chunk.length} of ${text.length}. Call again with offset ${next} for the rest.` : undefined,
        text: hasWords ? fence(chunk, `course file: ${name}`) : undefined,
      }));
    },
  });

  get({ name: 'list_my_files', group: J, description: 'Files in your personal Canvas storage.', path: '/users/self/files', schema: { search_term: z.string().optional(), limit: LIMIT }, params: (a) => ({ search_term: a.search_term }), paginate: true, fields: FILE_FIELDS });
  tool({ name: 'upload_to_my_files', group: J, write: true, confirm: true, preview: async (a) => ({ action: 'UPLOAD this file to your Canvas files', ...filePreview(a.file_path), parent_folder_path: a.parent_folder_path }), description: 'Upload a local file into your personal Canvas file storage.', schema: { file_path: z.string(), parent_folder_path: z.string().optional().describe("e.g. 'my subfolder'") }, handler: async (a) => ok(pick(await uploadFile('/users/self/files', a.file_path, { parent_folder_path: a.parent_folder_path }), ['id', 'display_name', 'size', 'url'])) });
  get({ name: 'get_storage_quota', group: J, description: 'Your personal Canvas storage quota and how much is used.', path: '/users/self/files/quota' });
  tool({ name: 'delete_my_file', group: J, write: true, confirm: true, preview: async (a) => { const f = await canvas.get(`/files/${a.file_id}`); return { action: 'DELETE this file from Canvas', file: f.display_name, size: f.size, updated_at: f.updated_at }; }, description: 'Delete a file from your personal Canvas storage.', schema: { file_id: ID }, handler: async (a) => ok(await canvas.del(`/files/${a.file_id}`), 'Deleted.') });
  tool({ name: 'create_folder', group: J, write: true, description: 'Create a folder in your personal Canvas storage.', schema: { name: z.string(), parent_folder_id: z.string().optional() }, handler: async (a) => ok(await canvas.post('/users/self/folders', { name: a.name, parent_folder_id: a.parent_folder_id })) });

  get({ name: 'list_pages', group: J, description: 'Wiki pages in a course.', path: (a) => `/courses/${a.course_id}/pages`, schema: { course_id: COURSE, search_term: z.string().optional(), limit: LIMIT }, params: (a) => ({ search_term: a.search_term, sort: 'updated_at', order: 'desc' }), paginate: true, fields: ['page_id', 'url', 'title', 'updated_at', 'published', 'front_page', 'html_url'] });
  tool({ name: 'get_page_content', group: J, description: 'Read a course page as text. Page bodies are HTML and are converted and provenance-fenced.', schema: { course_id: COURSE, page_url: z.string().describe('Page url slug or page_id') }, handler: async (a) => { const p = await canvas.get(`/courses/${a.course_id}/pages/${encodeURIComponent(a.page_url)}`); return ok({ title: p.title, updated_at: p.updated_at, html_url: p.html_url, body: fence(html2text(p.body), `course page: ${p.title}`) }); } });
  get({ name: 'list_page_revisions', group: J, description: 'Revision history for a course page.', path: (a) => `/courses/${a.course_id}/pages/${encodeURIComponent(a.page_url)}/revisions`, schema: { course_id: COURSE, page_url: z.string() }, paginate: true });
  get({ name: 'get_page_revision', group: J, description: 'One historical revision of a course page.', path: (a) => `/courses/${a.course_id}/pages/${encodeURIComponent(a.page_url)}/revisions/${a.revision_id}`, schema: { course_id: COURSE, page_url: z.string(), revision_id: ID }, fenceFields: ['body'] });

  get({ name: 'list_modules', group: J, description: 'Course modules with completion state and prerequisites.', path: (a) => `/courses/${a.course_id}/modules`, schema: { course_id: COURSE, limit: LIMIT }, params: () => ({ include: ['items'] }), paginate: true, fields: ['id', 'name', 'position', 'state', 'completed_at', 'unlock_at', 'prerequisite_module_ids', 'require_sequential_progress', 'items_count', 'published'] });
  get({ name: 'get_module', group: J, description: 'One module with its items.', path: (a) => `/courses/${a.course_id}/modules/${a.module_id}`, schema: { course_id: COURSE, module_id: ID }, params: () => ({ include: ['items'] }) });
  get({ name: 'list_module_items', group: J, description: 'Items in a module with your completion requirement status.', path: (a) => `/courses/${a.course_id}/modules/${a.module_id}/items`, schema: { course_id: COURSE, module_id: ID, limit: LIMIT }, params: () => ({ include: ['content_details'] }), paginate: true, fields: ['id', 'title', 'type', 'content_id', 'html_url', 'url', 'completion_requirement', 'content_details', 'indent', 'published'] });
  get({ name: 'get_module_item', group: J, description: 'One module item.', path: (a) => `/courses/${a.course_id}/modules/${a.module_id}/items/${a.item_id}`, schema: { course_id: COURSE, module_id: ID, item_id: ID }, params: () => ({ include: ['content_details'] }) });
  tool({ name: 'mark_module_item_done', group: J, write: true, description: 'Mark a module item as done, satisfying a must_mark_done completion requirement.', schema: { course_id: COURSE, module_id: ID, item_id: ID }, handler: async (a) => ok(await canvas.put(`/courses/${a.course_id}/modules/${a.module_id}/items/${a.item_id}/done`), 'Marked done.') });
  tool({ name: 'mark_module_item_read', group: J, write: true, description: 'Mark a module item as viewed, satisfying a must_view completion requirement.', schema: { course_id: COURSE, module_id: ID, item_id: ID }, handler: async (a) => ok(await canvas.post(`/courses/${a.course_id}/modules/${a.module_id}/items/${a.item_id}/mark_read`), 'Marked read.') });
  tool({ name: 'select_mastery_path', group: J, write: true, confirm: true, description: 'Choose a mastery path branch on a module item, where conditional release is enabled.', schema: { course_id: COURSE, module_id: ID, item_id: ID, assignment_set_id: ID }, handler: async (a) => ok(await canvas.post(`/courses/${a.course_id}/modules/${a.module_id}/items/${a.item_id}/select_mastery_path`, { assignment_set_id: a.assignment_set_id })) });
  get({ name: 'get_module_item_sequence', group: J, description: 'Previous/next navigation around a piece of content, showing where it sits in the module sequence.', path: (a) => `/courses/${a.course_id}/module_item_sequence`, schema: { course_id: COURSE, asset_type: z.enum(['ModuleItem', 'File', 'Page', 'Discussion', 'Assignment', 'Quiz', 'ExternalTool']), asset_id: ID }, params: (a) => ({ asset_type: a.asset_type, asset_id: a.asset_id }) });

  get({ name: 'list_media_objects', group: J, description: 'Media objects (recorded lectures, video/audio) in a course.', path: (a) => `/courses/${a.course_id}/media_objects`, schema: { course_id: COURSE, limit: LIMIT }, paginate: true, fields: ['media_id', 'title', 'media_type', 'can_add_captions', 'media_tracks'] });
  tool({
    name: 'get_media_captions', group: J,
    description: 'List caption/subtitle tracks available on a recorded lecture. Captions are the closest thing Canvas gives you to a lecture transcript.',
    schema: { media_id: z.string().describe('media_id from list_media_objects') },
    handler: async (a) => ok(fenceProse(await canvas.get(`/media_objects/${a.media_id}/media_tracks`, { include: ['content', 'webvtt_content'] }), 'lecture captions')),
  });
  tool({
    name: 'download_media_captions', group: J, local: true,
    description: 'Download a lecture caption track as text and save it locally. Turns a recorded lecture into a readable transcript.',
    schema: { media_id: z.string(), track_id: z.string().optional().describe('Defaults to the first English track'), dest_dir: z.string().optional() },
    handler: async (a) => {
      const tracks = await canvas.get(`/media_objects/${a.media_id}/media_tracks`, { include: ['content'] });
      if (!tracks?.length) return ok({ note: 'No caption tracks on this media object. The instructor may not have enabled captions.' });
      const t = a.track_id ? tracks.find((x) => String(x.id) === String(a.track_id)) : (tracks.find((x) => /^en/i.test(x.locale || '')) || tracks[0]);
      if (!t) return fail('Requested caption track not found.');
      let content = t.content;
      if (!content && t.url) content = (await readFile(t.url, MAX_FILE_BYTES, 'This caption track')).toString('utf8');
      if (!content) return fail('Caption track had no retrievable content.');
      const plain = content.replace(/^WEBVTT.*$/m, '').replace(/^\d+$/gm, '').replace(/^[\d:.,]+\s*-->\s*[\d:.,]+.*$/gm, '').replace(/\n{2,}/g, '\n').trim();
      const saved = await saveDownload({ text: plain, dir: a.dest_dir || DOWNLOAD_DIR, name: `captions-${a.media_id}-${t.locale || 'xx'}.txt`, contentType: 'text/plain' });
      return ok({ saved_to: saved.saved_to, locale: t.locale, characters: plain.length, preview: fence(plain.slice(0, 1500), 'lecture captions') }, null, { links: [saved.link] });
    },
  });

  tool({ name: 'create_content_export', group: J, write: true, confirm: true, preview: async (a) => ({ action: 'Ask Canvas to package this course as an export file', course_id: a.course_id, export_type: a.export_type || 'common_cartridge' }), description: 'Trigger a full course export (.imscc common cartridge). Useful for archiving a course before term-end access is revoked. Returns a progress URL; poll with get_content_export.', schema: { course_id: COURSE, export_type: z.enum(['common_cartridge', 'zip']).optional() }, handler: async (a) => ok(await canvas.post(`/courses/${a.course_id}/content_exports`, { export_type: a.export_type || 'common_cartridge', skip_notifications: true }), 'Export queued. Poll get_content_export with the returned id.') });
  get({ name: 'get_content_export', group: J, description: 'Check the status of a course export and get the download URL once ready.', path: (a) => `/courses/${a.course_id}/content_exports/${a.export_id}`, schema: { course_id: COURSE, export_id: ID } });

  get({ name: 'list_external_tools', group: J, description: 'LTI external tools available in a course (publisher platforms, proctoring, third-party apps).', path: (a) => `/courses/${a.course_id}/external_tools`, schema: { course_id: COURSE, limit: LIMIT }, paginate: true, fields: ['id', 'name', 'description', 'url', 'domain', 'workflow_state'] });
  get({ name: 'get_tool_launch_url', group: J, description: 'Get a sessionless launch URL for an LTI tool, so you can open it directly.', path: (a) => `/courses/${a.course_id}/external_tools/sessionless_launch`, schema: { course_id: COURSE, tool_id: z.string().optional(), url: z.string().optional() }, params: (a) => ({ id: a.tool_id, url: a.url }) });
  get({ name: 'list_conferences', group: J, description: 'Web conferences in a course (BigBlueButton, Zoom integrations).', path: (a) => `/courses/${a.course_id}/conferences`, schema: { course_id: COURSE }, paginate: true });
  get({ name: 'list_collaborations', group: J, description: 'Collaborative documents in a course (Google Docs / Office integrations).', path: (a) => `/courses/${a.course_id}/collaborations`, schema: { course_id: COURSE }, paginate: true });

  get({ name: 'list_eportfolios', group: J, description: 'Your Canvas ePortfolios (showcase sites of your work). Read-only; Canvas does not let other apps add entries, so edit them in Canvas itself.', path: '/users/self/eportfolios', schema: { include_deleted: z.boolean().optional().describe('If true, also list deleted ePortfolios.') }, params: (a) => ({ include: a.include_deleted ? ['deleted'] : undefined }), paginate: true, fields: ['id', 'name', 'public', 'workflow_state', 'created_at', 'updated_at', 'spam_status'] });
  tool({
    name: 'get_eportfolio_pages', group: J,
    description: 'The pages of one of your ePortfolios, with their text. Read-only.',
    schema: { eportfolio_id: ID.describe('ePortfolio ID from list_eportfolios.'), limit: LIMIT },
    handler: async (a) => {
      const pages = await canvas.paginate(`/eportfolios/${a.eportfolio_id}/pages`, null, { max: a.limit || 50 });
      return ok(pages.map((p) => omitEmpty({ id: p.id, name: p.name, position: p.position, updated: localize(p.updated_at), content: p.content ? fence(html2text(p.content), `ePortfolio page: ${p.name}`) : undefined })));
    },
  });
}
