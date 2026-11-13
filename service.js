// Start the Remote server automatically when you sign in: a Windows scheduled task, a Linux systemd user service
// or a macOS launch agent, all running `canvas-lms-mcp-remote start --log-file supervisor.log` from the settings
// folder (the log rotates itself). Used by `install-service`, `uninstall-service`, `restart` and `doctor`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
export const TASK_NAME = 'CanvasSupervisor';
export const UNIT = 'canvas-mcp-remote';
export const LABEL = 'io.github.fireiscoolsolo.canvas-mcp-remote';

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
const ps = (script, env = {}) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { ...process.env, ...env } });
const firstLine = (r) => String(r.stderr || r.stdout || '').trim().split('\n')[0];

export const unitFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', `${UNIT}.service`);
export const plistFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export function systemdUnit({ dir, node = process.execPath, cli = CLI }) {
  return `[Unit]
Description=Canvas MCP Remote (server, tunnel and failover)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${dir}
ExecStart=${node} ${cli} start --log-file supervisor.log
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function launchdPlist({ dir, node = process.execPath, cli = CLI }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>start</string><string>--log-file</string><string>supervisor.log</string></array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
`;
}

const unxml = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The launch agent as macOS has it: the folder and Node from its plist, and its state from `launchctl print`
 * ("running", "not running", or "not loaded" when launchd doesn't know it). Tests pass made-up readers.
 */
function macService({ exists, read, launchctl, uid }) {
  const file = plistFile();
  if (!exists(file)) return { installed: false, kind: 'launch agent', name: LABEL, file };
  let plist = '';
  try { plist = read(file); } catch { /* unreadable: report what we can */ }
  const args = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] || '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
  const dir = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  const printed = launchctl(['print', `gui/${uid}/${LABEL}`]);
  const state = printed.status === 0 ? (/^\s*state = (.+)$/m.exec(printed.stdout || '')?.[1]?.trim() || 'loaded') : 'not loaded';
  return { installed: true, kind: 'launch agent', name: LABEL, file, dir: dir === undefined ? undefined : unxml(dir), node: args[0], state };
}

/** A warning when the startup service runs a Node that is no longer there (an nvm or Homebrew upgrade removes it), else null. */
export function staleNode(svc, exists = fs.existsSync) {
  if (!svc?.installed || !svc.node || exists(svc.node)) return null;
  return `The startup service runs Node from ${svc.node}, which isn't there any more (updating Node with nvm or Homebrew can remove it), so it won't start. Run "canvas-lms-mcp-remote install-service" again.`;
}

/** Whether the startup service exists, and on Windows whether it still uses the old cmd redirect (no log rotation). */
export function serviceInfo({ name = TASK_NAME, platform = process.platform, exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8'), launchctl = (args) => run('launchctl', args), uid = os.userInfo().uid } = {}) {
  if (platform === 'win32') {
    const r = ps("$t = Get-ScheduledTask -TaskName $env:CMS_TASK -ErrorAction SilentlyContinue; if ($t) { [pscustomobject]@{ state = [string]$t.State; exe = $t.Actions[0].Execute; args = $t.Actions[0].Arguments; dir = $t.Actions[0].WorkingDirectory } | ConvertTo-Json -Compress }", { CMS_TASK: name });
    try {
      const j = JSON.parse(r.stdout.trim());
      return { installed: true, kind: 'Windows scheduled task', name, state: j.state, dir: j.dir, oldLog: /supervisor\.log/i.test(`${j.args}`) && !/--log-file/.test(`${j.args}`) };
    } catch { return { installed: false, kind: 'Windows scheduled task', name }; }
  }
  if (platform === 'darwin') return macService({ exists, read, launchctl, uid });
  const r = run('systemctl', ['--user', 'is-enabled', UNIT]);
  return { installed: fs.existsSync(unitFile()), enabled: r.status === 0, kind: 'systemd user service', name: UNIT, file: unitFile() };
}

export function installService({ dir, name = TASK_NAME, platform = process.platform }) {
  if (!fs.existsSync(path.join(dir, '.env'))) throw new Error(`There is no .env in ${dir}. Run this from your settings folder (or run "canvas-lms-mcp-remote init" first).`);
  if (platform === 'win32') {
    const r = ps(
      "$ErrorActionPreference = 'Stop'; " +
      "$arg = '\"' + $env:CMS_CLI + '\" start --log-file supervisor.log'; " +
      '$action = New-ScheduledTaskAction -Execute $env:CMS_NODE -Argument $arg -WorkingDirectory $env:CMS_DIR; ' +
      '$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"; ' +
      '$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew; ' +
      'Register-ScheduledTask -TaskName $env:CMS_TASK -Action $action -Trigger $trigger -Settings $settings -Description "Canvas MCP Remote (server, tunnel and failover)" -Force | Out-Null; ' +
      'Start-ScheduledTask -TaskName $env:CMS_TASK',
      { CMS_TASK: name, CMS_DIR: dir, CMS_CLI: CLI, CMS_NODE: process.execPath },
    );
    if (r.status !== 0) throw new Error(`Windows didn't create the startup task: ${firstLine(r)}`);
    return { kind: 'Windows scheduled task', name, note: 'It starts when you sign in to Windows, and restarts itself if it crashes.' };
  }
  if (platform === 'darwin') {
    fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
    fs.writeFileSync(plistFile(), launchdPlist({ dir }));
    // Apple prefers `launchctl bootstrap gui/<uid>` now, but `load` and `unload` still work for a launch agent in your
    // own folder. They stay until someone can check bootstrap on a real Mac.
    run('launchctl', ['unload', plistFile()]);
    const r = run('launchctl', ['load', '-w', plistFile()]);
    if (r.status !== 0) throw new Error(`launchctl couldn't load the agent: ${firstLine(r)}`);
    return { kind: 'launch agent', name: LABEL, note: 'It starts when you log in to your Mac, and restarts itself if it crashes.' };
  }
  fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
  fs.writeFileSync(unitFile(), systemdUnit({ dir }));
  run('systemctl', ['--user', 'daemon-reload']);
  const r = run('systemctl', ['--user', 'enable', '--now', UNIT]);
  if (r.status !== 0) throw new Error(`systemctl couldn't start the service: ${firstLine(r)}`);
  return { kind: 'systemd user service', name: UNIT, note: `It starts when you log in. To keep it running while you're logged out, run: loginctl enable-linger ${os.userInfo().username}` };
}

export function uninstallService({ name = TASK_NAME, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const r = ps('Unregister-ScheduledTask -TaskName $env:CMS_TASK -Confirm:$false -ErrorAction Stop', { CMS_TASK: name });
    return r.status === 0;
  }
  if (platform === 'darwin') {
    if (!fs.existsSync(plistFile())) return false;
    run('launchctl', ['unload', '-w', plistFile()]);
    fs.rmSync(plistFile());
    return true;
  }
  run('systemctl', ['--user', 'disable', '--now', UNIT]);
  if (!fs.existsSync(unitFile())) return false;
  fs.rmSync(unitFile());
  run('systemctl', ['--user', 'daemon-reload']);
  return true;
}

/** Start the installed service now. Returns false when there is no service to start. */
export function startService({ name = TASK_NAME, platform = process.platform } = {}) {
  if (platform === 'win32') return ps('Start-ScheduledTask -TaskName $env:CMS_TASK -ErrorAction Stop', { CMS_TASK: name }).status === 0;
  if (platform === 'darwin') return run('launchctl', ['kickstart', '-k', `gui/${os.userInfo().uid}/${LABEL}`]).status === 0;
  return run('systemctl', ['--user', 'start', UNIT]).status === 0;
}
