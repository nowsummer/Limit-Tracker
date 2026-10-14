'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { accountEnvironment } = require('./accounts.cjs');
const { t } = require('./i18n.cjs');
// Only Claude Code and Codex sign in, through their own official CLI. Gemini is
// manual entry only (1.6), so no Gemini CLI is located, downloaded or started.
function loginCommand(executable, providerId) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\r\n\0]/.test(executable)) throw new Error(t('login.badPath'));
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const args = providerId === 'claude' ? 'auth login' : providerId === 'codex' ? 'login' : null;
  if (args === null) throw new Error(t('login.unsupported'));
  // One console process: acknowledge OS spawn instead of timing a nested PowerShell startup.
  // CLI owns the OAuth browser flow and writes credentials into its own isolated directory.
  return `$Host.UI.RawUI.WindowTitle = 'Limit Tracker - ${providerId}'; try { & ${quote(executable)} ${args}; if ($LASTEXITCODE -ne 0) { Read-Host 'Login did not finish. Press Enter to close' } } catch { Write-Host 'Unable to start the CLI. Reinstall the official CLI and try again.'; Read-Host 'Press Enter to close' }`;
}
function launchLoginProcess({ executable, account, userData, inherited = process.env, spawnImpl = spawn, launchTimeoutMs = 30000 }) {
  // Checks the provider and path before anything is created on disk.
  const command = loginCommand(executable, account.providerId);
  const env = accountEnvironment(account, userData, inherited);
  if (account.mode === 'isolated') fs.mkdirSync(account.providerId === 'claude' ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const shell = path.join(inherited.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  // Electron is a GUI process with no interactive handles to inherit. Giving the
  // CLI Node's ignored/piped stdio breaks its prompts. Start-Process allocates a
  // real visible console; this hidden bootstrap emits only its PID, never OAuth
  // output, and waits so the caller still receives the target's eventual exit.
  const bootstrap = `$ErrorActionPreference = 'Stop'; try { $loginProcess = Start-Process -FilePath ${quote(shell)} -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${encoded}') -WorkingDirectory ${quote(userData)} -WindowStyle Normal -PassThru; [Console]::Out.WriteLine('LIMIT_TRACKER_LOGIN_PID:' + $loginProcess.Id); [Console]::Out.Flush(); $loginProcess.WaitForExit(); exit $loginProcess.ExitCode } catch { [Console]::Out.WriteLine('LIMIT_TRACKER_LOGIN_ERROR'); exit 1 }`;
  return new Promise((resolve, reject) => {
    let child, settled = false, output = '', timer;
    const fail = () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // A slow bootstrap must not open an untracked login window later.
      try { if (child && child.exitCode === null) child.kill(); } catch { /* Already gone. */ }
      reject(new Error(t('login.launchFailed')));
    };
    try {
      child = spawnImpl(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], { env, cwd: userData, detached: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      child.once('error', fail);
      child.once('exit', fail);
      child.stderr?.on('data', () => {});
      child.stdout?.on('data', data => {
        if (settled) return;
        output = (output + data.toString('utf8')).slice(-4096);
        const match = /LIMIT_TRACKER_LOGIN_PID:(\d+)\r?\n/.exec(output);
        if (match) {
          settled = true; clearTimeout(timer); child.loginPid = Number(match[1]);
          child.stdin?.end?.(); child.unref(); child.stdout?.unref?.(); child.stderr?.unref?.(); resolve(child);
        } else if (output.includes('LIMIT_TRACKER_LOGIN_ERROR')) fail();
      });
      timer = setTimeout(fail, Math.max(1, launchTimeoutMs));
      timer.unref?.();
    } catch { fail(); }
  });
}
module.exports = { loginCommand, launchLoginProcess };
