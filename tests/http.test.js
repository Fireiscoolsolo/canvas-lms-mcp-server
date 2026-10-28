// Starts the server in its normal HTTP mode (no tunnel, no OAuth) and checks the health endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39399;

test('HTTP mode serves /healthz with all tools', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, CANVAS_API_TOKEN: 'test-token', CANVAS_BASE_URL: 'https://example.invalid', CANVAS_MCP_PORT: String(PORT), CANVAS_MCP_TRANSPORT: 'http' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 20000);
      child.stderr.on('data', (d) => { if (String(d).includes('ready on http://')) { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => reject(new Error(`server exited early (code ${code})`)));
    });
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tools, 211);
    assert.equal(body.auth_enabled, false);
  } finally {
    child.kill();
  }
});
