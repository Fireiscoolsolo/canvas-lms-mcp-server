// The tool profile table for the README and the website, made from the real server so the counts can't drift.
//   node scripts/profile-table.mjs           prints it as Markdown and as an HTML table
//   node scripts/profile-table.mjs --write   puts it between <!-- profiles:start --> and <!-- profiles:end --> in
//                                            README.md and docs/index.html
// tests/core/tool-count.test.js checks every marked block. This file is the same in both repos.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvasServer } from '../core/index.js';
import { PROFILES, profileIncludes } from '../core/profiles.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const START = '<!-- profiles:start -->';
export const END = '<!-- profiles:end -->';
export const PLACES = ['README.md', 'docs/index.html'];

/** Each profile with the number of tools it turns on, counted from every tool the server has. */
export function profileRows() {
  const built = createCanvasServer({ env: {}, version: 'profile-table' });
  const all = [...built.registry, ...built.leftOut];
  return PROFILES.map((p) => ({ number: p.number, id: p.id, summary: p.summary, tools: all.filter((t) => profileIncludes(p, t)).length }));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** { markdown, html }: the same table both ways. Counts are bare numbers, so the "N tools" check leaves them alone. */
export function profileTable(rows = profileRows()) {
  const markdown = [
    '| Number | Name | What it\'s for | Tools |',
    '|:-:|---|---|:-:|',
    ...rows.map((r) => `| ${r.number} | \`${r.id}\` | ${r.summary} | ${r.tools} |`),
  ].join('\n');
  const html = [
    '<div class="tbl"><table>',
    '    <tr><th>Number</th><th>Name</th><th>What it\'s for</th><th>Tools</th></tr>',
    ...rows.map((r) => `    <tr><td>${r.number}</td><td><code>${esc(r.id)}</code></td><td>${esc(r.summary)}</td><td>${r.tools}</td></tr>`),
    '  </table></div>',
  ].join('\n');
  return { markdown, html };
}

const BLOCK = new RegExp(`(${START})[\\s\\S]*?(\\s*${END})`, 'g');

/** Re-make every marked block in this repo. Returns the files that changed. */
export function writeTables(root = ROOT, table = profileTable()) {
  const changed = [];
  for (const place of PLACES) {
    const file = path.join(root, place);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const body = (place.endsWith('.md') ? table.markdown : table.html).replace(/\n/g, eol);
    const after = before.replace(BLOCK, (_, start, end) => `${start}${eol}${body}${end}`);
    if (after !== before) { fs.writeFileSync(file, after); changed.push(place); }
  }
  return changed;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--write')) {
    const changed = writeTables();
    console.log(changed.length ? `Updated ${changed.join(' and ')}.` : 'Every profile table is already up to date.');
  } else {
    const { markdown, html } = profileTable();
    console.log(`${markdown}\n\n${html}`);
  }
}
