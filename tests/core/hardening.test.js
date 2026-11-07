// Smaller hardening: the school address is always encrypted, archives and downloads have a size limit, file names
// can't hide what they are, and long lists say when they were cut short. Fake Canvas and temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './fake-canvas.js';
import { normalizeBase } from '../../core/canvas-client.js';
import { readConfig } from '../../core/config.js';

// ---------------------------------------------------------------------------------------------------------------
// F23: the token never travels unencrypted
// ---------------------------------------------------------------------------------------------------------------

test('a school address written with http:// is used with https://', () => {
  assert.equal(normalizeBase('http://school.instructure.com'), 'https://school.instructure.com');
  assert.equal(normalizeBase('HTTP://School.Instructure.com/api/v1/'), 'https://School.Instructure.com');
  assert.equal(normalizeBase('school.instructure.com'), 'https://school.instructure.com');
  assert.equal(normalizeBase('https://school.instructure.com'), 'https://school.instructure.com');
});

test('a Canvas running on this computer keeps http://, for development', () => {
  for (const base of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'http://canvas.localhost']) {
    assert.equal(normalizeBase(base), base);
  }
});

test('the change is reported, so nobody wonders why the address looks different', async () => {
  const cfg = readConfig({ CANVAS_API_TOKEN: 't', CANVAS_BASE_URL: 'http://school.instructure.com' }, { readStore: () => '' });
  assert.equal(cfg.base, 'https://school.instructure.com');
  assert.match(cfg.baseNote || '', /https/);
  const lines = [];
  const s = await connect({ env: { CANVAS_BASE_URL: 'http://canvas.example.edu' }, log: (l) => lines.push(l) });
  try {
    s.built.start();
    assert.ok(lines.some((l) => /http:\/\/.*https:\/\//.test(l)), lines.join('\n'));
  } finally { await s.close(); }
});
