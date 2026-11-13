// Keep the Canvas token in the operating system's password store instead of a config file:
// Windows Credential Manager (PasswordVault), the macOS Keychain, or the Linux Secret Service (secret-tool).
// The token is passed through stdin when saving, so it never shows up in a process list.
import { execFileSync } from 'node:child_process';

export const SERVICE = 'canvas-lms-mcp';
export const ACCOUNT = 'canvas';

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const VAULT = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;";
const run = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 });
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

export const storeName = (platform = process.platform) => (platform === 'win32' ? 'Windows Credential Manager' : platform === 'darwin' ? 'the macOS Keychain' : 'the system keyring (secret-tool)');

/** Read the stored token. Returns '' when there isn't one; throws only when the store itself can't be used. */
export function readStoredToken({ service = SERVICE, account = ACCOUNT, platform = process.platform } = {}) {
  try {
    if (platform === 'win32') {
      return run('powershell.exe', [...PS, `$ErrorActionPreference='Stop';${VAULT}$c=$v.Retrieve(${q(service)},${q(account)});$c.RetrievePassword();[Console]::Out.Write($c.Password)`]).trim();
    }
    if (platform === 'darwin') return run('security', ['find-generic-password', '-s', service, '-a', account, '-w']).trim();
    return run('secret-tool', ['lookup', 'service', service, 'account', account]).trim();
  } catch (e) {
    const text = `${e.stderr || ''} ${e.message || ''}`;
    if (/not found|could not be found|cannot find|element not found|0x80070490/i.test(text) || e.status === 1 || e.status === 44) return '';
    throw new Error(`Couldn't read the Canvas token from ${storeName(platform)}: ${text.trim().split('\n')[0]}`);
  }
}

/** Save (or replace) the token in the password store. */
export function saveStoredToken(token, { service = SERVICE, account = ACCOUNT, platform = process.platform } = {}) {
  const value = String(token || '').trim();
  if (!value) throw new Error('No token to save.');
  // The macOS command line below puts the token inside quotes. A Canvas token never has these, so one that does was
  // copied wrong, and it must not change the command.
  if (/["\\\r\n]/.test(value)) throw new Error('That token has a character a Canvas token never has (a quote, backslash or line break), so it wasn\'t saved. Copy it again from Canvas.');
  if (platform === 'win32') {
    run('powershell.exe', [...PS, `$ErrorActionPreference='Stop';$t=[Console]::In.ReadToEnd().Trim();${VAULT}try{$v.Remove($v.Retrieve(${q(service)},${q(account)}))}catch{};$v.Add((New-Object Windows.Security.Credentials.PasswordCredential(${q(service)},${q(account)},$t)))`], value);
  } else if (platform === 'darwin') {
    run('security', ['-i'], `add-generic-password -U -s "${service}" -a "${account}" -l "Canvas LMS token" -w "${value.replace(/"/g, '\\"')}"\n`);
  } else {
    run('secret-tool', ['store', '--label=Canvas LMS token', 'service', service, 'account', account], value);
  }
}

/** Remove the stored token. Returns true if one was removed. */
export function deleteStoredToken({ service = SERVICE, account = ACCOUNT, platform = process.platform } = {}) {
  try {
    if (platform === 'win32') run('powershell.exe', [...PS, `$ErrorActionPreference='Stop';${VAULT}$v.Remove($v.Retrieve(${q(service)},${q(account)}))`]);
    else if (platform === 'darwin') run('security', ['delete-generic-password', '-s', service, '-a', account]);
    else run('secret-tool', ['clear', 'service', service, 'account', account]);
    return true;
  } catch {
    return false;
  }
}
