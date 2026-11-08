// Optional two-factor codes for the login page (RFC 6238 TOTP: the 6-digit codes from Google Authenticator,
// Microsoft Authenticator, 1Password and the like). Turned on by CANVAS_MCP_TOTP_SECRET.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('The two-factor secret has characters that are not allowed.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** The code for one 30-second step. */
export function totp(secret, { now = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / step)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const n = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

/** The 30-second step a code belongs to: the current one, or the one before or after for a clock a little off. */
function matchingStep(secret, code, now) {
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  for (const w of [-1, 0, 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, { now: now + w * 30000 })), Buffer.from(given))) return Math.floor((now + w * 30000) / 30000);
  }
  return null;
}

/** Whether a code is right, whether or not it was used before. */
export function verifyTotp(secret, code, { now = Date.now() } = {}) {
  return matchingStep(secret, code, now) !== null;
}

// The newest step accepted for each secret. Shared by the sign-in page and the status page, so a code seen on one
// can't be replayed on the other. Kept in memory: a code is only good for about a minute anyway.
const lastAccepted = new Map();

/** Sign-in check: a right code that hasn't been used yet. Using it means this code, and older ones, stop working. */
export function acceptTotp(secret, code, { now = Date.now() } = {}) {
  const step = matchingStep(secret, code, now);
  const key = crypto.createHash('sha256').update(String(secret)).digest('hex');
  if (step === null || step <= (lastAccepted.get(key) ?? -Infinity)) return false;
  lastAccepted.set(key, step);
  return true;
}

/** The link an authenticator app scans (shown as a QR code by the setup app). */
export function otpauthUrl(secret, { label = 'Canvas MCP', issuer = 'Canvas MCP' } = {}) {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
