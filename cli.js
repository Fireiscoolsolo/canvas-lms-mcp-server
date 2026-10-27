#!/usr/bin/env node
// Command-line entry for the npm package. Run it from the folder that holds your .env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) || 'start';
const stdio = args.includes('--stdio') || cmd === 'stdio' || process.env.CANVAS_MCP_TRANSPORT === 'stdio';

const usage = `canvas-lms-mcp-remote: self-hosted Canvas LMS MCP server

Run these from the folder that holds your .env (it also stores logins and logs):

  canvas-lms-mcp-remote init      Create a .env template here
  canvas-lms-mcp-remote           Start the supervisor: server + ngrok tunnel + failover
  canvas-lms-mcp-remote serve     Start only the HTTP server on 127.0.0.1 (no tunnel)
  canvas-lms-mcp-remote --stdio   Serve over stdin/stdout (for directory checks)

Guide: https://github.com/Fireiscoolsolo/canvas-lms-mcp-server#-quick-start`;

if (args.includes('--help') || args.includes('-h') || cmd === 'help') {
  console.log(usage);
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version);
} else if (stdio) {
  process.env.CANVAS_MCP_TRANSPORT = 'stdio';
  await import('./index.js');
} else if (cmd === 'init') {
  const target = path.join(process.cwd(), '.env');
  if (fs.existsSync(target)) {
    console.log(`.env already exists in ${process.cwd()}, leaving it unchanged.`);
  } else {
    fs.copyFileSync(path.join(PKG_DIR, '.env.example'), target);
    console.log(`Created ${target}\nFill in your Canvas token, ngrok domain, password and cluster secret, then run: canvas-lms-mcp-remote`);
  }
} else if (cmd === 'serve') {
  await import('./index.js');
} else if (cmd === 'start') {
  await import('./supervisor.js');
} else {
  console.error(`Unknown command: ${cmd}\n\n${usage}`);
  process.exit(1);
}
