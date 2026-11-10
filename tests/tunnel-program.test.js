// Finding ngrok and cloudflared on every system: the setting if there is one, the winget install on Windows, and
// otherwise PATH plus the folders Homebrew and the usual installers use, so a Mac or Linux setup works without a
// setting even when the server starts with a bare PATH. Made-up folders only; nothing looks at the real disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTunnelProgram } from '../startup-check.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const find = (kind, { env = {}, platform, files = [] }) => findTunnelProgram(kind, { env, platform, home: platform === 'win32' ? 'C:\\Users\\sam' : '/Users/sam', exists: (p) => files.includes(p) });

test('a path in the settings always wins', () => {
  assert.deepEqual(find('ngrok', { env: { CANVAS_MCP_NGROK_PATH: '/custom/ngrok' }, platform: 'darwin' }), { path: '/custom/ngrok', how: 'setting' });
  assert.deepEqual(find('cloudflared', { env: { CANVAS_MCP_CLOUDFLARED_PATH: 'D:\\cf.exe' }, platform: 'win32' }), { path: 'D:\\cf.exe', how: 'setting' });
});

test('on a Mac, ngrok and cloudflared from Homebrew are found with no setting and a bare PATH', () => {
  const env = { PATH: '/usr/bin:/bin' };
  assert.deepEqual(find('ngrok', { env, platform: 'darwin', files: ['/opt/homebrew/bin/ngrok'] }), { path: '/opt/homebrew/bin/ngrok', how: 'found' });
  assert.deepEqual(find('ngrok', { env, platform: 'darwin', files: ['/usr/local/bin/ngrok'] }), { path: '/usr/local/bin/ngrok', how: 'found' }, 'an Intel Mac');
  assert.deepEqual(find('cloudflared', { env, platform: 'darwin', files: ['/opt/homebrew/bin/cloudflared'] }), { path: '/opt/homebrew/bin/cloudflared', how: 'found' });
});

test('on Linux, a program on PATH or in the usual folders is found', () => {
  assert.deepEqual(find('ngrok', { env: { PATH: '/home/sam/bin:/usr/bin' }, platform: 'linux', files: ['/home/sam/bin/ngrok'] }), { path: '/home/sam/bin/ngrok', how: 'found' });
  assert.deepEqual(find('ngrok', { env: { PATH: '/usr/bin' }, platform: 'linux', files: ['/snap/bin/ngrok'] }), { path: '/snap/bin/ngrok', how: 'found' });
});

test('on Windows, the winget install comes first, then PATH', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local', PATH: 'C:\\Windows;C:\\tools' };
  const winget = 'C:\\Users\\sam\\AppData\\Local\\Microsoft\\WinGet\\Links\\ngrok.exe';
  assert.deepEqual(find('ngrok', { env, platform: 'win32', files: [winget, 'C:\\tools\\ngrok.exe'] }), { path: winget, how: 'found' });
  assert.deepEqual(find('ngrok', { env, platform: 'win32', files: ['C:\\tools\\ngrok.exe'] }), { path: 'C:\\tools\\ngrok.exe', how: 'found' });
});

test('when it is nowhere, the answer says so', () => {
  assert.equal(find('ngrok', { env: { PATH: '/usr/bin' }, platform: 'darwin' }).how, 'missing');
  assert.equal(find('cloudflared', { env: { PATH: 'C:\\Windows' }, platform: 'win32' }).how, 'missing');
});

test('the supervisor and doctor both use it', () => {
  for (const file of ['supervisor.js', 'doctor.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /import \{[^}]*findTunnelProgram[^}]*\} from '\.\/startup-check\.js'/, file);
    assert.match(source, /find(?:TunnelProgram|Program)\('ngrok'/, file);
    assert.match(source, /find(?:TunnelProgram|Program)\('cloudflared'/, file);
    assert.doesNotMatch(source, /'WinGet', 'Links', 'ngrok\.exe'/, `${file} has no Windows-only default of its own`);
  }
});
