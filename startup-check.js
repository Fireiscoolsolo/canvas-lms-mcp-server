// What the HTTP server refuses to start with. A public address without a real password would put your Canvas on the
// internet, so these stop it with a clear message instead of carrying on. Used by index.js, supervisor.js and doctor.js.
// stdio mode skips this: nothing listens on a port there.
import { readConfig } from './core/config.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const EXAMPLE_VALUE = /^(paste_your|choose_a|generate_a)/; // the words .env.example ships with
const GOOD_PASSWORD = 12;
const GOOD_SECRET = 16;

/**
 * Returns { errors: [{ key, message }], warnings: [text] }. Any error means don't start. A short password only warns
 * for now: the setup app accepts one, and refusing it outright would take a working server offline during an update.
 */
export function startupProblems(env = process.env) {
  const errors = [];
  const warnings = [];
  const refuse = (key, message) => errors.push({ key, message });
  const host = String(env.CANVAS_MCP_HOST || '127.0.0.1').trim();
  const publicUrl = String(env.CANVAS_MCP_PUBLIC_URL || '').trim();
  const password = String(env.CANVAS_MCP_PASSWORD || '').trim();
  const secret = String(env.CANVAS_MCP_CLUSTER_SECRET || '').trim();

  if (!publicUrl && !LOOPBACK.has(host)) {
    refuse('CANVAS_MCP_PUBLIC_URL', `CANVAS_MCP_HOST is ${host}, so other computers can reach this server, but sign-in only turns on with CANVAS_MCP_PUBLIC_URL and CANVAS_MCP_PASSWORD. Set both, or use 127.0.0.1.`);
  }
  if (publicUrl && !password) refuse('CANVAS_MCP_PASSWORD', 'CANVAS_MCP_PUBLIC_URL is set but CANVAS_MCP_PASSWORD is empty, so anyone who finds the address could use your Canvas. Set a password in .env.');
  else if (publicUrl && EXAMPLE_VALUE.test(password)) refuse('CANVAS_MCP_PASSWORD', 'CANVAS_MCP_PASSWORD is still the example value from .env.example, which anyone can look up. Choose your own in .env.');
  else if (publicUrl && password.length < GOOD_PASSWORD) warnings.push(`The password is short. Use ${GOOD_PASSWORD} or more characters ("canvas-lms-mcp-remote rotate-password" makes a strong one). A later version will refuse short ones.`);

  if (secret && EXAMPLE_VALUE.test(secret)) refuse('CANVAS_MCP_CLUSTER_SECRET', 'CANVAS_MCP_CLUSTER_SECRET is still the example value from .env.example, which anyone can look up. Put a long random value in .env, the same on every computer.');
  else if (secret && secret.length < GOOD_SECRET) refuse('CANVAS_MCP_CLUSTER_SECRET', `CANVAS_MCP_CLUSTER_SECRET is too short. Use ${GOOD_SECRET} or more random characters in .env, the same on every computer.`);

  const { settingsProblem } = readConfig(env, { readStore: () => '' });
  if (settingsProblem) refuse('settings', settingsProblem);
  return { errors, warnings };
}
