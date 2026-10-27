// Starts the server the way an MCP client does (stdio) and checks it lists every tool with clean protocol output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_TOOLS = 209;

test('server starts over stdio and lists all tools', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, CANVAS_API_TOKEN: 'test-token', CANVAS_BASE_URL: 'https://example.invalid', CANVAS_MCP_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', nonJson = 0, id = 0;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { nonJson++; continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'canvas-lms');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    assert.equal(list.result.tools.length, EXPECTED_TOOLS);
    assert.equal(nonJson, 0, 'stdout must carry only protocol messages');
    for (const t of list.result.tools) {
      assert.ok(t.title, `${t.name} has a title`);
      for (const [k, v] of Object.entries(t.inputSchema.properties || {})) assert.ok(v.description, `${t.name}.${k} has a description`);
    }
  } finally {
    child.kill();
  }
});
