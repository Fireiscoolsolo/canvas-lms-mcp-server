// The files that hold sign-ins and secrets: a crash mid-write never leaves them half-written, a bad copy from another
// computer is never saved, only you can read them on Linux and macOS, and git never picks them up. Temp folders and
// made-up values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOAuthProvider, saveStoreCopy } from '../oauth-provider.js';
import { setEnvValues } from '../env-file.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-files-'));
const POSIX = process.platform !== 'win32';
const modeOf = (file) => fs.statSync(file).mode & 0o777;
const GOOD = { clients: { a: { client_id: 'a', client_name: 'App' } }, refreshTokens: { r: { clientId: 'a', scopes: [] } }, accessTokens: {} };

test('a copy of the sign-ins from the other computer is saved whole, or not at all', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'oauth-store.json');
    fs.writeFileSync(file, JSON.stringify(GOOD));
    fs.mkdirSync(`${file}.tmp`); // the write can't finish, as if the computer crashed part way
    assert.equal(saveStoreCopy(file, { ...GOOD, clients: { b: { client_id: 'b' } } }), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), GOOD, 'the sign-ins already here are untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a copy that isn\'t shaped like sign-ins is never saved', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'oauth-store.json');
    fs.writeFileSync(file, JSON.stringify(GOOD));
    for (const bad of [{}, [], null, 'text', { clients: [] , refreshTokens: {}, accessTokens: {} }, { clients: {}, refreshTokens: {} },
      { clients: { a: 'not an app' }, refreshTokens: {}, accessTokens: {} }, { clients: {}, refreshTokens: { r: {} }, accessTokens: {} },
      { ...GOOD, usedRefreshTokens: [] }]) {
      assert.equal(saveStoreCopy(file, bad), false, JSON.stringify(bad));
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), GOOD);
    assert.equal(saveStoreCopy(file, { ...GOOD, usedRefreshTokens: {} }), true);
    assert.ok(!fs.existsSync(`${file}.tmp`), 'no temp file is left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the supervisor saves the copy through that check', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supervisor.js'), 'utf8');
  assert.match(source, /saveStoreCopy\(OAUTH_STORE_PATH, handoff\.data\)/);
  assert.doesNotMatch(source, /writeFileSync\(OAUTH_STORE_PATH/);
});

test('the login history is written whole, or not at all', () => {
  const dir = tmp();
  try {
    const historyPath = path.join(dir, 'login-history.json');
    const auth = createOAuthProvider({ password: 'pw-1234567890', storePath: path.join(dir, 'store.json'), historyPath });
    auth.passwordAttempt('198.51.100.1', 'nope');
    const before = fs.readFileSync(historyPath, 'utf8');
    fs.mkdirSync(`${historyPath}.tmp`);
    auth.passwordAttempt('198.51.100.1', 'nope again');
    assert.equal(fs.readFileSync(historyPath, 'utf8'), before, 'a write that can\'t finish leaves the old history');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only you can read the sign-ins, the history, .env and its backups', { skip: !POSIX && 'file modes are a Linux and macOS thing' }, () => {
  const dir = tmp();
  try {
    const storePath = path.join(dir, 'store.json');
    const historyPath = path.join(dir, 'login-history.json');
    const auth = createOAuthProvider({ password: 'pw-1234567890', storePath, historyPath });
    auth.provider.clientsStore.registerClient({ client_name: 'App', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    auth.passwordAttempt('198.51.100.1', 'nope');
    assert.equal(modeOf(storePath), 0o600);
    assert.equal(modeOf(historyPath), 0o600);
    const env = path.join(dir, '.env');
    fs.writeFileSync(env, 'CANVAS_MCP_PASSWORD=old-made-up\n', { mode: 0o644 });
    const backup = setEnvValues(env, { CANVAS_MCP_PASSWORD: 'new-made-up' });
    assert.equal(modeOf(backup), 0o600);
    assert.equal(modeOf(env), 0o600);
    const copy = path.join(dir, 'copy.json');
    saveStoreCopy(copy, GOOD);
    assert.equal(modeOf(copy), 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('git ignores every file that holds a secret or a sign-in', { skip: spawnSync('git', ['--version']).status !== 0 && 'git is not installed' }, () => {
  const names = ['.env', '.env.backup-20261107-120000', 'oauth-store.json', 'oauth-store.json.tmp', 'login-history.json', 'login-history.json.tmp', 'supervisor.log'];
  for (const name of names) {
    const r = spawnSync('git', ['check-ignore', '-q', '--no-index', name], { cwd: ROOT });
    assert.equal(r.status, 0, `${name} should be git-ignored`);
  }
});
