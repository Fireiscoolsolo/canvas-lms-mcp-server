// Watches when the Canvas token this server uses expires, so every answer can carry a heads-up in its last week.
// Canvas lists your tokens with a short hint (the first few characters), which is how ours is told apart.

const DAY = 86400000;
export const WARN_DAYS = 7;

/** Find this server's token in Canvas's token list. Returns null if it can't be told apart from the others. */
export function matchToken(tokens, token) {
  if (!token) return null;
  const mine = (tokens || []).filter((t) => {
    const hint = String(t.token_hint || '').replace(/[.…*]+$/, '').replace(/^[.…*]+/, '');
    return hint.length >= 4 && (token.startsWith(hint) || token.endsWith(hint));
  });
  if (!mine.length) return null;
  mine.sort((a, b) => new Date(b.last_used_at || 0) - new Date(a.last_used_at || 0));
  const t = mine[0];
  return { id: t.id, purpose: t.purpose || t.app_name || null, expires_at: t.expires_at || null, last_used_at: t.last_used_at || null };
}

export function daysLeft(expiresAt, now = Date.now()) {
  return expiresAt ? (new Date(expiresAt).getTime() - now) / DAY : null;
}

export function createTokenWatch({ canvas, token, base, log = () => {}, now = () => Date.now() }) {
  let info = null;
  let timer = null;

  async function check() {
    if (!token) return null;
    try {
      const me = await canvas.get('/users/self', null, { ttl: 0 });
      const tokens = await canvas.paginate(`/users/${me.id}/user_generated_tokens`, {}, { max: 100, ttl: 0 });
      info = matchToken(tokens, token);
      const d = daysLeft(info?.expires_at, now());
      if (d !== null && d <= WARN_DAYS) log(`the Canvas token expires in ${Math.max(0, Math.ceil(d))} day(s)`);
    } catch { /* many schools block listing tokens; then there is simply no heads-up */ }
    return info;
  }

  /** The heads-up line for tool answers, or null when the token isn't expiring within a week. */
  function notice() {
    const d = daysLeft(info?.expires_at, now());
    if (d === null || d < 0 || d > WARN_DAYS) return null;
    const n = Math.ceil(d);
    const when = n <= 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`;
    const on = new Date(info.expires_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return `Heads up (tell the user): the Canvas token this server uses expires ${when} (${on}). Make a new one at ${base}/profile/settings and put it in the AI app's Canvas settings, or use the Installer Assistant's Auto update, so Canvas keeps working.`;
  }

  return {
    check,
    notice,
    info: () => info,
    start() {
      check();
      timer = setInterval(check, 6 * 3600000);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
