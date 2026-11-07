// The number of tools written in the README, the website and the package listings matches what the server really
// registers, in both editions. The count has needed fixing by hand in several places before; now a test catches it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './fake-canvas.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLACES = ['README.md', 'docs/index.html', 'package.json', 'server.json', 'mcpb/manifest.json', 'glama.json'];
// An exact count: "237 tools" or "237 student tools". "About 50 tools" for the core profile is left alone on purpose.
const COUNT = /(?<!about )\b(\d{2,4}) (?:student )?tools\b/gi;

/** Every written count in `root` that isn't `count`, as "file: number". */
function wrongCounts(root, count) {
  const wrong = [];
  for (const place of PLACES) {
    const file = path.join(root, place);
    if (!fs.existsSync(file)) continue;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(COUNT)) if (Number(m[1]) !== count) wrong.push(`${place}: ${m[0]}`);
  }
  return wrong;
}

test('every tool count written in this repo matches the tools the server registers', async () => {
  const { built, close } = await connect();
  try {
    const count = built.registry.length;
    assert.ok(count > 100, `${count} tools registered`);
    assert.deepEqual(wrongCounts(ROOT, count), [], `the server registers ${count} tools`);
  } finally { await close(); }
});

test('a count that is off is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-count-'));
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), 'Now with 236 student tools. The core profile has about 50 tools.');
    assert.deepEqual(wrongCounts(dir, 237), ['README.md: 236 student tools']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
