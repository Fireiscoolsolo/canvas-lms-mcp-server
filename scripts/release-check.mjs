// Before publishing: every file that names the version agrees, the changelog has a section for it, and if this
// commit is tagged, the tag is that version. The publish workflow runs it; it's safe to run any time.
//   node scripts/release-check.mjs [repo folder]
// The same file is in both editions' repos.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const has = (file) => fs.existsSync(path.join(ROOT, file));
const json = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

const pkg = json('package.json');
const version = pkg.version;
const problems = [];

if (has('server.json')) {
  const server = json('server.json');
  if (server.version !== version) problems.push(`server.json says ${server.version}`);
  for (const p of server.packages || []) {
    if (p.identifier === pkg.name && p.version !== version) problems.push(`the npm package in server.json says ${p.version}`);
  }
}
if (has(path.join('mcpb', 'manifest.json'))) {
  const manifest = json(path.join('mcpb', 'manifest.json'));
  if (manifest.version !== version) problems.push(`the Claude Desktop extension (mcpb/manifest.json) says ${manifest.version}`);
}
const changelog = has('CHANGELOG.md') ? fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8') : '';
if (!new RegExp(`^## ${version.replace(/[.]/g, '\\.')}\\s*$`, 'm').test(changelog)) problems.push(`CHANGELOG.md has no "## ${version}" section`);

let tags = [];
try {
  tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s+/).filter(Boolean);
} catch { /* not a git checkout */ }
if (tags.length && !tags.includes(`v${version}`)) problems.push(`this commit is tagged ${tags.join(', ')}, not v${version}`);

if (problems.length) {
  console.error(`Not ready to publish ${pkg.name} ${version}: ${problems.join('; ')}.`);
  process.exit(1);
}
console.log(`${pkg.name} ${version}: every version agrees${tags.includes(`v${version}`) ? `, and this commit is tagged v${version}` : ''}.`);
