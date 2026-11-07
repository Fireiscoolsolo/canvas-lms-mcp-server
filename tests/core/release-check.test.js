// Before a publish: every file that names the version agrees, and the changelog has that version. Runs the release
// check in each repo against itself and against made-up folders. No network, no publishing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release-check.mjs');
const check = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

/** A made-up repo folder at version 1.0.0, with whatever changes `edit` makes. */
function repo(edit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-release-'));
  const files = {
    'package.json': { name: 'demo-pkg', version: '1.0.0' },
    'server.json': { name: 'io.github.demo/demo', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'demo-pkg', version: '1.0.0' }] },
    'mcpb/manifest.json': { name: 'demo', version: '1.0.0' },
  };
  edit(files);
  for (const [name, data] of Object.entries(files)) {
    if (name === 'changelog') continue;
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  }
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), files.changelog ?? '# Changelog\n\n## 1.0.0\n- First.\n');
  return dir;
}

test('the release check ships in this repo', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/release-check.mjs is missing');
});

test('this repo is ready to publish as far as versions go', () => {
  const r = check(ROOT);
  assert.equal(r.status, 0, r.stderr);
});

test('matching versions pass', () => {
  const dir = repo();
  try { assert.equal(check(dir).status, 0); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a version that disagrees anywhere stops the publish', () => {
  for (const [what, edit] of [
    ['server.json', (f) => { f['server.json'].version = '0.9.0'; }],
    ['the npm package in server.json', (f) => { f['server.json'].packages[0].version = '0.9.0'; }],
    ['the Claude Desktop extension', (f) => { f['mcpb/manifest.json'].version = '0.9.0'; }],
    ['the changelog', (f) => { f.changelog = '# Changelog\n\n## Unreleased\n- Something.\n\n## 0.9.0\n'; }],
  ]) {
    const dir = repo(edit);
    try {
      const r = check(dir);
      assert.equal(r.status, 1, what);
      assert.match(r.stderr, /Not ready to publish demo-pkg 1\.0\.0/, what);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
