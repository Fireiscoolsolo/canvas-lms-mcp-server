// Canvas REST client shared by the Local and Remote servers.
//   - Requests are SERIALIZED. Canvas throttles by request cost and adds a pre-flight penalty to parallel requests.
//   - As the rate-limit quota runs low the client waits a little before each request instead of hitting the wall.
//   - Pagination follows the Link header (case-insensitively), never page counters.
//   - Errors are written for people: what happened and how to fix it, not a status code and a stack trace.

export class CanvasError extends Error {
  constructor(message, { status, url, body, code, host, attempts, step } = {}) {
    super(message);
    this.name = 'CanvasError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.code = code;
    this.host = host;
    this.attempts = attempts;
    this.step = step;
  }
}

/** Normalize the base URL. Accepts with or without https://, a trailing slash and /api/v1. */
export function normalizeBase(raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b.replace(/\/api\/v1$/i, '');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The message Canvas put in an error body, if any. */
export function canvasMessage(body) {
  let data = body;
  if (typeof body === 'string') { try { data = JSON.parse(body); } catch { return ''; } }
  if (!data || typeof data !== 'object') return '';
  if (Array.isArray(data.errors)) return data.errors.map((e) => e?.message || '').filter(Boolean).join(' ');
  if (data.errors && typeof data.errors === 'object') {
    return Object.entries(data.errors).map(([k, v]) => `${k}: ${[].concat(v).map((x) => x?.message || x).join(', ')}`).join('; ');
  }
  return String(data.message || data.error || '');
}

const shortPath = (url) => { try { return new URL(url).pathname.replace(/^\/api\/v1/, ''); } catch { return String(url || ''); } };

/** Turn an HTTP failure into something a person (and the model) can act on. */
export function explainStatus(status, url, body, { base = '' } = {}) {
  const said = canvasMessage(body);
  const lower = `${said} ${typeof body === 'string' ? body : ''}`.toLowerCase();
  const where = `(HTTP ${status} at ${shortPath(url)})`;
  const settings = base ? `${base}/profile/settings` : 'Canvas > Account > Settings';
  const rateLimited = lower.includes('rate limit');
  if (status === 401 && !lower.includes('not authorized')) {
    return `Your Canvas token was rejected: it expired, was deleted, or was copied wrong. Canvas makes student tokens expire (often after 30 to 120 days). Make a new one at ${settings} (Approved Integrations, + New Access Token) and put it in your AI app's Canvas settings. On Windows, the free Installer Assistant's Auto update can swap it everywhere at once. ${where}`;
  }
  if (status === 429 || (status === 403 && rateLimited)) {
    return `Canvas is rate-limiting requests right now. Wait a minute and try again; this server already slows itself down. ${where}`;
  }
  if (status === 401 || status === 403) {
    return `Canvas says your account isn't allowed to do this. Your school or teacher may have turned the feature off, or it's only for teachers. Nothing was changed. ${where}${said ? ` Canvas said: ${said}` : ''}`;
  }
  if (status === 404) {
    return `Canvas couldn't find that. The ID may be wrong, the item may be unpublished or deleted, the course may have ended, or your school hasn't turned this feature on. Check the ID with one of the list_ tools. ${where}`;
  }
  if (status === 400 || status === 409 || status === 422) {
    return `Canvas didn't accept the request${said ? `: ${said}` : '.'} Check the values you sent and try again. ${where}`;
  }
  if (status >= 500) {
    return `Canvas had a problem on its end. This is usually temporary, so try again in a few minutes (status page: https://status.instructure.com). ${where}`;
  }
  return `Canvas returned an error. ${where} ${said || (typeof body === 'string' ? body.slice(0, 300) : '')}`.trim();
}

export function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (m) return m[1];
  }
  return null;
}

/** How long to wait before the next request, from the quota Canvas reported last (it starts around 700). */
export function throttleDelay(remaining) {
  if (remaining === null || remaining === undefined || Number.isNaN(remaining)) return 0;
  if (remaining < 50) return 3000;
  if (remaining < 150) return 1000;
  if (remaining < 300) return 250;
  return 0;
}

// Errors where the connection never opened, so nothing reached Canvas and even a write is safe to repeat.
// ECONNRESET and the like are left out on purpose: they can arrive after Canvas has already acted on the request.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT']);

const timedOut = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

/** True when a failed fetch provably never reached the server. Trying several addresses fails with a list of errors. */
export function neverSent(e) {
  const c = e?.cause || e;
  return (c?.errors?.length ? c.errors : [c]).every((x) => NOT_SENT.has(x?.code) || x?.syscall === 'connect' || x?.syscall === 'getaddrinfo');
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Addresses in text cut down to their host, because upload URLs carry signed parameters. */
export const hideAddresses = (text) => String(text ?? '').replace(/https?:\/\/[^\s)]+/g, (u) => hostOf(u) || 'that address');

/** A failed fetch as a CanvasError that says which host failed and why. The school-address hint only shows for Canvas itself. */
export function networkError(e, { url, base = '', attempts = 1, timeoutMs = 0 }) {
  const host = hostOf(url);
  const isCanvas = Boolean(host) && host === hostOf(base);
  const tries = attempts > 1 ? ` after ${attempts} attempts` : '';
  if (timedOut(e)) {
    return new CanvasError(`${isCanvas ? 'Canvas' : host || 'The server'} didn't answer within ${Math.round(timeoutMs / 1000)} seconds${tries}. It may be slow or down; try again shortly.`, { url, code: 'TIMEOUT', host, attempts });
  }
  const c = e?.cause || e;
  const code = c?.code || c?.errors?.[0]?.code || '';
  const reason = hideAddresses(c?.message || e?.message);
  const help = isCanvas ? `Check your internet connection and the school address (${base}).` : 'Check your internet connection.';
  return new CanvasError(`Couldn't reach ${isCanvas ? `Canvas at ${host}` : host || 'the server'} (${code ? `${code}: ` : ''}${reason})${tries}. ${help}`, { url, code, host, attempts });
}

/**
 * fetch for requests outside the client's queue (storage uploads, file downloads), with the same backoff. `init` runs
 * for every attempt, so a form is built fresh each time. Only for requests that do no harm if repeated. One that ran
 * out of time isn't repeated, because it would only wait just as long again.
 */
export async function fetchWithRetry(fetchImpl, url, init, { retries = 3, base = '', timeoutMs }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchImpl(url, { ...init(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt > retries || timedOut(e)) throw networkError(e, { url, base, attempts: attempt, timeoutMs });
      await sleep(500 * attempt);
    }
  }
}

export class CanvasClient {
  constructor({ api, token, ttl, base = '', fetchImpl = fetch, timeoutMs = 60000 }) {
    this.api = api;
    this.token = token;
    this.ttl = ttl;
    this.base = base;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();          // key -> { at, data }
    this.chain = Promise.resolve();  // serialization queue
    this.lastCost = null;
    this.lastRemaining = null;
    this.requestCount = 0;
  }

  /** Serialize every outbound request. Parallelism is actively penalized by Canvas. */
  enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  buildUrl(p, params) {
    const url = new URL(/^https?:\/\//i.test(p) ? p : `${this.api}${p.startsWith('/') ? '' : '/'}${p}`);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        const key = k.endsWith('[]') ? k : `${k}[]`;
        for (const item of v) if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
      } else if (typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv !== undefined && sv !== null) url.searchParams.append(`${k}[${sk}]`, String(sv));
        }
      } else {
        url.searchParams.append(k, String(v));
      }
    }
    return url.toString();
  }

  /** `repeatable` marks a write where a second copy does no harm, like asking for an upload slot. */
  async raw(method, p, { params, body, headers, retries = 3, expectJson = true, repeatable = false } = {}) {
    const url = this.buildUrl(p, params);
    const idempotent = method === 'GET' || repeatable;
    return this.enqueue(async () => {
      let attempt = 0;
      for (;;) {
        attempt++;
        const wait = throttleDelay(this.lastRemaining);
        if (wait) await sleep(wait);
        this.requestCount++;
        const h = {
          Authorization: `Bearer ${this.token}`,
          // Force 64-bit IDs to strings so JS never mangles them.
          Accept: 'application/json+canvas-string-ids, application/json',
          ...(headers || {}),
        };
        let payload;
        if (body !== undefined) {
          h['Content-Type'] = 'application/json';
          payload = JSON.stringify(body);
        }
        let res;
        try {
          res = await this.fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (e) {
          if (attempt <= retries && (idempotent || neverSent(e))) { await sleep(500 * attempt); continue; }
          throw networkError(e, { url, base: this.base, attempts: attempt, timeoutMs: this.timeoutMs });
        }

        const cost = res.headers.get('x-request-cost');
        const remaining = res.headers.get('x-rate-limit-remaining');
        if (cost) this.lastCost = Number(cost);
        if (remaining) this.lastRemaining = Number(remaining);

        const throttled = res.status === 429 || (res.status === 403 && remaining && Number(remaining) <= 0);
        if (throttled && attempt <= retries) {
          const after = Number(res.headers.get('retry-after'));
          await sleep(after > 0 ? Math.min(after, 60) * 1000 : 1500 * attempt * attempt);
          continue;
        }
        if (res.status >= 500 && idempotent && attempt <= retries) { await sleep(1000 * attempt); continue; }

        if (!res.ok) {
          let b = '';
          try { b = await res.text(); } catch { /* ignore */ }
          throw new CanvasError(explainStatus(res.status, url, b, { base: this.base }), { status: res.status, url, body: b });
        }

        if (!expectJson) return { res, data: null, link: res.headers.get('link') };
        const text = await res.text();
        let data = null;
        if (text) {
          try { data = JSON.parse(text); }
          catch { throw new CanvasError(`Canvas sent back a web page instead of data. The school address probably points at a login page; it should look like https://yourschool.instructure.com. (${shortPath(url)})`, { url, body: text.slice(0, 200) }); }
        }
        return { res, data, link: res.headers.get('link') };
      }
    });
  }

  cacheKey(method, p, params) { return `${method} ${this.buildUrl(p, params)}`; }

  async get(p, params, { ttl } = {}) {
    const key = this.cacheKey('GET', p, params);
    const useTtl = ttl === undefined ? this.ttl : ttl;
    if (useTtl > 0) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < useTtl) return hit.data;
    }
    const { data } = await this.raw('GET', p, { params });
    if (useTtl > 0) this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  /**
   * Follow rel="next" Link headers until exhausted or `max` items collected.
   * Header names are not case-guaranteed, so parsing is case-insensitive.
   */
  async paginate(p, params, { max = 500, ttl } = {}) {
    const key = `PAGES ${this.cacheKey('GET', p, params)}|${max}`;
    const useTtl = ttl === undefined ? this.ttl : ttl;
    if (useTtl > 0) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < useTtl) return hit.data;
    }
    const out = [];
    let next = this.buildUrl(p, { per_page: 100, ...(params || {}) });
    let guard = 0;
    while (next && out.length < max && guard < 25) {
      guard++;
      const { data, link } = await this.raw('GET', next);
      if (Array.isArray(data)) out.push(...data);
      else if (data) { out.push(data); break; }
      next = parseNextLink(link);
    }
    const sliced = out.slice(0, max);
    if (useTtl > 0) this.cache.set(key, { at: Date.now(), data: sliced });
    return sliced;
  }

  // Any change drops the whole cache, so the next read after a submit, post or edit always sees the new state.
  async post(p, body, params, options) { this.cache.clear(); return (await this.raw('POST', p, { body, params, ...options })).data; }
  async put(p, body, params) { this.cache.clear(); return (await this.raw('PUT', p, { body, params })).data; }
  async del(p, params) { this.cache.clear(); return (await this.raw('DELETE', p, { params })).data; }
}
