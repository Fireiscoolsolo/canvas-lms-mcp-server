// The Mac launch agent: what install-service writes, and what doctor reads back. Made-up launchctl output and file
// readers only; nothing is installed or started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchdPlist, serviceInfo, staleNode } from '../service.js';

const PRINTED = `gui/501/io.github.fireiscoolsolo.canvas-mcp-remote = {
\tactive count = 1
\tpath = /Users/sam/Library/LaunchAgents/io.github.fireiscoolsolo.canvas-mcp-remote.plist
\ttype = LaunchAgent
\tstate = running
\tprogram = /opt/homebrew/bin/node
}`;

const mac = (plist, printed = { status: 0, stdout: PRINTED }) => serviceInfo({ platform: 'darwin', uid: 501, exists: () => plist !== null, read: () => plist, launchctl: () => printed });

test('the plist keeps a folder name with & and < intact', () => {
  const plist = launchdPlist({ dir: '/Users/sam/Canvas <A & B>', node: '/opt/homebrew/bin/node', cli: '/opt/c/cli.js' });
  assert.match(plist, /<string>\/Users\/sam\/Canvas &lt;A &amp; B&gt;<\/string>/);
  assert.doesNotMatch(plist, /<A & B>/);
});

test('on a Mac, doctor learns the agent\'s folder, its Node and whether it is running', () => {
  const plist = launchdPlist({ dir: '/Users/sam/Canvas <A & B>', node: '/opt/homebrew/bin/node', cli: '/opt/c/cli.js' });
  const s = mac(plist);
  assert.equal(s.installed, true);
  assert.equal(s.dir, '/Users/sam/Canvas <A & B>', 'the folder is read back as written, so "runs from another folder" works');
  assert.equal(s.node, '/opt/homebrew/bin/node');
  assert.equal(s.state, 'running');
  assert.equal(mac(plist, { status: 113, stdout: '', stderr: 'Could not find service' }).state, 'not loaded');
  assert.deepEqual(mac(null), { installed: false, kind: 'launch agent', name: 'io.github.fireiscoolsolo.canvas-mcp-remote', file: s.file });
});

test('doctor warns when the agent\'s Node is gone, as after an nvm upgrade', () => {
  const svc = { installed: true, kind: 'launch agent', node: '/Users/sam/.nvm/versions/node/v20.1.0/bin/node' };
  assert.match(staleNode(svc, () => false), /install-service/);
  assert.equal(staleNode(svc, () => true), null);
  assert.equal(staleNode({ installed: true, kind: 'Windows scheduled task' }, () => false), null, 'nothing to check without a Node path');
});
