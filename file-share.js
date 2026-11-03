// Download links for files the server saved (course files, deadline calendars, archives), so an app on a phone can
// open them: each link carries a long random key, works for one hour, and only serves files this server saved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createFileShare({ publicUrl, ttlMs = 3600000, now = () => Date.now() }) {
  const shares = new Map(); // key -> { file, name, mimeType, expires }

  const prune = () => { for (const [k, s] of shares) if (s.expires < now()) shares.delete(k); };

  /** A resource link for a saved file, used as the fileLink option of createCanvasServer. */
  function link(abs, { name, mimeType, bytes } = {}) {
    prune();
    const key = crypto.randomBytes(24).toString('base64url');
    const shown = name || path.basename(abs);
    shares.set(key, { file: abs, name: shown, mimeType, expires: now() + ttlMs });
    return {
      type: 'resource_link',
      uri: `${publicUrl}/files/${key}/${encodeURIComponent(shown)}`,
      name: shown,
      ...(mimeType ? { mimeType } : {}),
      ...(bytes ? { size: bytes } : {}),
      description: 'Download link from your Canvas server. It works for one hour.',
    };
  }

  /** Express handler for GET /files/:key/:name. */
  function handler(req, res) {
    const s = shares.get(req.params.key);
    if (!s || s.expires < now() || !fs.existsSync(s.file)) {
      res.status(404).type('text').send('This download link has expired. Ask the assistant to fetch the file again.');
      return;
    }
    res.set('Cache-Control', 'private, no-store');
    res.download(s.file, s.name);
  }

  return { link, handler, size: () => shares.size };
}
