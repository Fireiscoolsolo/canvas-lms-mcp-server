// Search. Registered by core/index.js; ctx carries the shared client, helpers and config.
import { z } from 'zod';

export default function register(ctx) {
  const { tool, canvas, ok, fence, fenceProse, html2text, COURSE, LIMIT, API } = ctx;

  const M = 'search';

  tool({
    name: 'smart_search', group: M,
    description: "Canvas's meaning-based (embedding) search over course content. This is a BETA Canvas feature with limited availability, so it frequently returns 404. Falls back to a plain keyword scan when unavailable.",
    schema: { course_id: COURSE, query: z.string(), filter: z.array(z.enum(['pages', 'assignments', 'announcements', 'discussion_topics'])).optional() },
    handler: async (a) => {
      try {
        const r = await canvas.get(`/courses/${a.course_id}/smartsearch`, { q: a.query, filter: a.filter, include: ['status', 'modules'] });
        return ok(fenceProse(r, 'smart search result'));
      } catch (e) {
        if (e.status === 404 || e.status === 403) return ok({ smart_search_available: false, note: 'Smart Search is not enabled on this Canvas instance. Use search_course_content instead.' });
        throw e;
      }
    },
  });

  tool({
    name: 'search_course_content', group: M,
    description: 'Keyword search across a course: pages, assignments, announcements and discussion titles/bodies. Works everywhere, unlike smart_search.',
    schema: { course_id: COURSE, query: z.string(), limit: LIMIT },
    handler: async (a) => {
      const q = a.query.toLowerCase();
      const hits = [];
      const scan = (items, type, titleKey, bodyKey, urlKey) => {
        for (const it of items || []) {
          const title = String(it[titleKey] || '');
          const body = html2text(String(it[bodyKey] || ''));
          if (title.toLowerCase().includes(q) || body.toLowerCase().includes(q)) {
            const idx = body.toLowerCase().indexOf(q);
            hits.push({ type, title, html_url: it[urlKey], id: it.id || it.page_id, excerpt: idx >= 0 ? fence(body.slice(Math.max(0, idx - 120), idx + 240), `${type}: ${title}`) : null });
          }
        }
      };
      try { scan(await canvas.paginate(`/courses/${a.course_id}/assignments`, null, { max: 150 }), 'assignment', 'name', 'description', 'html_url'); } catch { /* */ }
      try { scan(await canvas.paginate(`/courses/${a.course_id}/discussion_topics`, null, { max: 100 }), 'discussion', 'title', 'message', 'html_url'); } catch { /* */ }
      try { scan(await canvas.paginate(`/courses/${a.course_id}/discussion_topics`, { only_announcements: true }, { max: 60 }), 'announcement', 'title', 'message', 'html_url'); } catch { /* */ }
      try {
        const pages = await canvas.paginate(`/courses/${a.course_id}/pages`, null, { max: 60 });
        for (const p of pages) {
          if (String(p.title || '').toLowerCase().includes(q)) { hits.push({ type: 'page', title: p.title, html_url: p.html_url, id: p.page_id }); continue; }
          try { const full = await canvas.get(`/courses/${a.course_id}/pages/${encodeURIComponent(p.url)}`); scan([full], 'page', 'title', 'body', 'html_url'); } catch { /* */ }
        }
      } catch { /* */ }
      try { const files = await canvas.paginate(`/courses/${a.course_id}/files`, { search_term: a.query }, { max: 40 }); for (const f of files) hits.push({ type: 'file', title: f.display_name, id: f.id, url: f.url }); } catch { /* */ }
      return ok({ query: a.query, hit_count: hits.length, hits: hits.slice(0, a.limit || 40) });
    },
  });

  tool({
    name: 'grep_all_courses', group: M,
    description: 'Keyword search across every active course at once. Expensive in API calls; prefer search_course_content when you know the course.',
    schema: { query: z.string(), limit: LIMIT },
    handler: async (a, { progress }) => {
      const courses = await canvas.paginate('/courses', { enrollment_state: 'active' }, { max: 20 });
      const all = [];
      for (const [i, c] of courses.entries()) {
        progress(i, courses.length, `Searching ${c.name}`);
        try {
          const asgs = await canvas.paginate(`/courses/${c.id}/assignments`, { search_term: a.query }, { max: 30 });
          for (const x of asgs) all.push({ course: c.name, course_id: c.id, type: 'assignment', title: x.name, id: x.id, due_at: x.due_at, html_url: x.html_url });
          const tops = await canvas.paginate(`/courses/${c.id}/discussion_topics`, { search_term: a.query }, { max: 20 });
          for (const x of tops) all.push({ course: c.name, course_id: c.id, type: 'discussion', title: x.title, id: x.id, html_url: x.html_url });
          const files = await canvas.paginate(`/courses/${c.id}/files`, { search_term: a.query }, { max: 20 });
          for (const x of files) all.push({ course: c.name, course_id: c.id, type: 'file', title: x.display_name, id: x.id });
        } catch { /* course may block a resource */ }
      }
      return ok({ query: a.query, searched_courses: courses.length, hit_count: all.length, hits: all.slice(0, a.limit || 60) });
    },
  });
}
