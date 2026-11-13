// Things that only happen on a Mac: macOS asks before a program may open Desktop, Documents or Downloads, apps keep
// their settings under ~/Library, and the Keychain is driven through the `security` command. Fake Canvas and temp
// folders only; nothing touches the real Keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './fake-canvas.js';
import { explainFsError } from '../../core/shared.js';
import { saveStoredToken } from '../../core/token-store.js';

const text = (r) => (r.content || []).map((c) => c.text || '').join('\n');
const blocked = (code) => Object.assign(new Error(`${code}: operation not permitted`), { code });

test('a file in a Mac app\'s or browser\'s private folder is never uploaded', async () => {
  const calls = [];
  const { client, dir, close } = await connect({ calls });
  try {
    const folders = [
      ['Library', 'Application Support', 'Cursor', 'User', 'notes.txt'], ['Library', 'Application Support', 'Windsurf', 'notes.txt'],
      ['Library', 'Application Support', 'ngrok', 'ngrok.txt'], ['Library', 'Application Support', 'BraveSoftware', 'notes.txt'],
      ['Library', 'Application Support', 'Arc', 'notes.txt'], ['Library', 'Safari', 'History.txt'], ['Library', 'Cookies', 'notes.txt'],
      ['.config', 'ngrok', 'notes.txt'], ['.config', 'devin', 'mcp_config.txt'],
    ];
    for (const f of folders.map((parts) => path.join(dir, ...parts))) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'pretend secret');
      const r = await client.callTool({ name: 'upload_to_my_files', arguments: { file_path: f } });
      assert.equal(r.isError, true, f);
      assert.match(text(r), /private file/, f);
    }
    assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing was sent');
  } finally { await close(); }
});

test('when macOS blocks a folder, the message says what happened and how to allow it', () => {
  for (const code of ['EPERM', 'EACCES']) {
    const up = explainFsError(blocked(code), '/Users/sam/Desktop/essay.docx', { platform: 'darwin' });
    assert.match(up.message, /macOS/);
    assert.match(up.message, /System Settings → Privacy & Security → Files and Folders/);
    assert.match(up.message, /essay\.docx/);
    const save = explainFsError(blocked(code), '/Users/sam/Downloads/Canvas', { platform: 'darwin', saving: true });
    assert.match(save.message, /CANVAS_DOWNLOAD_DIR/);
    assert.match(save.message, /Nothing was saved/);
  }
  assert.match(explainFsError(blocked('EACCES'), '/home/sam/x.txt', { platform: 'linux' }).message, /permission/i);
  assert.equal(explainFsError(Object.assign(new Error('nope'), { code: 'ENOENT' }), '/x', { platform: 'darwin' }), null, 'other errors are left alone');
});

test('a folder the server isn\'t allowed to open gives the plain message, for uploads and downloads', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs a non-root user on macOS or Linux' }, async () => {
  const { client, dir, close } = await connect({ env: (d) => ({ CANVAS_DOWNLOAD_DIR: path.join(d, 'locked', 'Canvas') }) });
  const locked = path.join(dir, 'locked');
  try {
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'essay.txt'), 'hi');
    fs.chmodSync(locked, 0o000);
    const up = await client.callTool({ name: 'upload_to_my_files', arguments: { file_path: path.join(locked, 'essay.txt') } });
    assert.equal(up.isError, true);
    assert.doesNotMatch(text(up), /File not found/);
    assert.match(text(up), process.platform === 'darwin' ? /System Settings/ : /permission/i);
    const down = await client.callTool({ name: 'download_file', arguments: { file_id: '1' } });
    assert.equal(down.isError, true);
    assert.match(text(down), /CANVAS_DOWNLOAD_DIR/);
  } finally {
    fs.chmodSync(locked, 0o700);
    await close();
  }
});

test('a token with a quote, backslash or line break is refused before the Keychain is touched', () => {
  for (const bad of ['a"b', 'a\\b', 'a\nb', 'a\rb']) {
    assert.throws(() => saveStoredToken(bad, { platform: 'darwin' }), /character a Canvas token never has/, JSON.stringify(bad));
  }
});
