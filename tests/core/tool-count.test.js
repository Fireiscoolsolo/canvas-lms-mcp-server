// The number of tools written in the README, the website and the package listings matches what the server really
// registers, in both editions. The count has needed fixing by hand in several places before; now a test catches it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './fake-canvas.js';
import { profileTable, START, END, PLACES as TABLE_PLACES } from '../../scripts/profile-table.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLACES = ['README.md', 'docs/index.html', 'package.json', 'server.json', 'mcpb/manifest.json', 'glama.json'];
// An exact count: "237 tools" or "237 student tools". "About 50 tools" is left alone on purpose.
const COUNT = /(?<!about )\b(\d{2,4}) (?:student )?tools\b/gi;
// The profile table holds the smaller counts; it has its own check below.
const TABLE = new RegExp(`${START}[\\s\\S]*?${END}`, 'g');

/** Every written count in `root` that isn't `count`, as "file: number". */
function wrongCounts(root, count) {
  const wrong = [];
  for (const place of PLACES) {
    const file = path.join(root, place);
    if (!fs.existsSync(file)) continue;
    for (const m of fs.readFileSync(file, 'utf8').replace(TABLE, '').matchAll(COUNT)) if (Number(m[1]) !== count) wrong.push(`${place}: ${m[0]}`);
  }
  return wrong;
}

test('the profile table in the README and the website matches the real profiles', () => {
  const { markdown, html } = profileTable();
  for (const place of TABLE_PLACES) {
    const said = fs.readFileSync(path.join(ROOT, place), 'utf8').replace(/\r\n/g, '\n');
    const blocks = [...said.matchAll(new RegExp(`${START}\\n([\\s\\S]*?)\\n\\s*${END}`, 'g'))].map((m) => m[1]);
    assert.ok(blocks.length > 0, `${place} needs the profile table between ${START} and ${END}`);
    for (const b of blocks) assert.equal(b, place.endsWith('.md') ? markdown : html, `${place} is out of date: run node scripts/profile-table.mjs --write`);
  }
});

test('every tool count written in this repo matches the tools the server registers', async () => {
  const { built, close } = await connect();
  try {
    const count = built.registry.length;
    assert.ok(count > 100, `${count} tools registered`);
    assert.deepEqual(wrongCounts(ROOT, count), [], `the server registers ${count} tools`);
  } finally { await close(); }
});

test('the count for each tool group in the README and the website matches the server', async () => {
  const { built, close } = await connect();
  try {
    const counts = {};
    for (const t of built.registry) counts[t.group] = (counts[t.group] || 0) + 1;
    const wrong = [];
    for (const place of ['README.md', 'docs/index.html']) {
      const said = fs.readFileSync(path.join(ROOT, place), 'utf8');
      const rows = [...said.matchAll(/^\| ([A-Z][a-z]+) \| (\d+) \|/gm), ...said.matchAll(/<b>([A-Z][a-z]+)<\/b><span class="cnt">(\d+)<\/span>/g)];
      const groups = rows.filter(([, name]) => counts[name.toLowerCase()] !== undefined);
      assert.equal(groups.length, Object.keys(counts).length, `${place} lists every group once`);
      for (const [, name, n] of groups) if (counts[name.toLowerCase()] !== Number(n)) wrong.push(`${place}: ${name} says ${n}, the server has ${counts[name.toLowerCase()]}`);
    }
    assert.deepEqual(wrong, []);
  } finally { await close(); }
});

test('a count that is off is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-count-'));
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), 'Now with 236 student tools. The core profile has about 50 tools.');
    assert.deepEqual(wrongCounts(dir, 237), ['README.md: 236 student tools']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
