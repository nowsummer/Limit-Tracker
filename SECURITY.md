# Security

Limit Tracker is a one-person, independent project. This page explains how to report a problem privately, what the app can access on your PC, and the risks of its update and distribution model.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Email **limittracker.app@gmail.com** with a subject starting with `Security:`.
- If this repository's **Security** tab shows **Report a vulnerability**, you can use GitHub's private vulnerability reporting instead.

Include the app version (Settings → About), what you found, steps to reproduce, and the impact you expect. Never send your own passwords, tokens, credential files, or the iPhone connection URL; redact them, along with account names and Windows user paths, from logs and screenshots.

There is no guaranteed response time. Fixes ship in a new release, and only the latest release is supported. Once a fix is out, the report can be credited and discussed publicly if you agree.

## What the app accesses

**Files**

- Claude Code's login, `.credentials.json` in `%USERPROFILE%\.claude` (or `CLAUDE_CONFIG_DIR`): read, and rewritten when the access token is renewed, honoring Claude Code's lock files. Each renewal is first saved to `.limit-tracker-refresh.json` in the same folder and removed once `.credentials.json` is updated; if that update fails, it stays until the next successful save. If the file has no login, the `CLAUDE_CODE_OAUTH_TOKEN` environment variable is used instead (never renewed). Inside WSL distributions that are already running, the same file is only read.
- Its own folder, `%APPDATA%\Limit Tracker`: settings (account names, which accounts to show, preferences, the random key for the iPhone page), separate-account CLI logins under `accounts\`, alert state, a tray icon cache, and `logs\main.log` with errors and update events.
- The app does not read Codex's login files.

**Programs**

- The Codex CLI installed on your PC, started as `codex app-server` with Codex analytics turned off, to read Codex account type and rate limits.
- When you click **Sign in** for an automatic account: `claude auth login` or `codex login` in a visible Windows PowerShell console. A hidden PowerShell starts that console with an encoded command and `-ExecutionPolicy Bypass`, so the command line is passed intact.
- `wsl.exe`, to list WSL distributions that are already running and read the Claude Code login inside them. It never starts or installs WSL.
- Windows PowerShell, to register the app's notification name and icon under `HKCU\Software\Classes\AppUserModelId`.
- The downloaded update installer, only when you choose to install it. The installer uses PowerShell or `taskkill` to close a running copy of the app.

**Network**

- `api.anthropic.com` (Claude usage) and `platform.claude.com` (Claude token renewal). Claude tokens are sent only to these two fixed HTTPS addresses, and redirects are refused.
- OpenAI only through the Codex CLI. The app itself makes no request to OpenAI.
- `github.com` and GitHub's download servers for updates.
- The optional iPhone page on your local network, port 43821, described below.

There is no analytics, telemetry, or crash reporting.

**Windows**

- A per-user install under `%LOCALAPPDATA%\Programs`, Start menu and desktop shortcuts, a sign-in startup entry if you turn on **Start with Windows**, and the notification registration above.
- Uninstalling keeps `%APPDATA%\Limit Tracker` (settings and separate-account logins) and `%LOCALAPPDATA%\limit-tracker-updater` (downloaded installers). Delete both folders to remove everything.

## Known risks

**Claude login use.** Automatic Claude tracking reads, uses, and renews your Claude Code subscription login from a third-party app, and its requests identify themselves as Claude Code. Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page does not permit third-party apps to use Free, Pro, or Max credentials this way and says Anthropic may act without notice, so your Claude account could be restricted. Manual entry avoids this.

**Gemini.** Versions up to 1.5.6 used the Gemini CLI login for automatic tracking, which Google's [Gemini CLI terms](https://www.geminicli.com/docs/resources/tos-privacy) prohibit for third-party software. 1.6.0 makes Gemini manual only and no longer reads those logins. A Gemini account that used a separate login in 1.5 leaves its old login under `%APPDATA%\Limit Tracker\accounts\<id>\gemini`; delete that folder, and remove Gemini CLI's access in your Google account's third-party connections if you no longer use it.

**iPhone page.** When turned on, the app serves a read-only page over plain HTTP on port 43821 on all network adapters. It answers only private IPv4 addresses, and usage data requires the 64-character key in the URL. The connection is not encrypted, so anyone on the same network who sees the URL can read account names and usage numbers. Turn it off on networks you do not trust. The key does not change on its own. To revoke a shared URL, quit the app, set `"mobileKey": ""` in `%APPDATA%\Limit Tracker\settings.json`, and start it again; a new key and URL are created and saved.

## Updates and their risk

From 1.6.0, the updater works like this:

1. With **Check for new versions** on (the default), the app checks the latest release on GitHub about 90 seconds after starting and every 6 hours.
2. A newer release is downloaded in the background to `%LOCALAPPDATA%\limit-tracker-updater`.
3. Nothing is installed until you choose to: **Restart now to apply** in Settings, or **Install &lt;version&gt; and restart** in the tray menu. Nothing installs at startup, at exit, or on a timer.

Installed copies of 1.5.x install updates on their own, so they update themselves once more, to 1.6.0 or later. From 1.6.0 on, every install waits for your click. Turning **Check for new versions** off stops automatic checks and downloads.

The risk: the download is checked only against the SHA-512 in `latest.yml` from the same GitHub release, and the installers are not code-signed. If the maintainer's GitHub account or build PC were compromised, a malicious release would pass that check. Asking before installing gives you a chance to read the release notes and wait. It cannot prove a release is genuine.

## Unsigned binaries

Installers are not signed with a code-signing certificate, so Windows SmartScreen or Smart App Control may warn about or block them. Builds are not reproducible, so a published installer cannot be byte-compared with one you build.

What you can do:

- Compare the `sha256:` digest shown next to each file on the [release page](https://github.com/nowsummer/Limit-Tracker/releases) with `Get-FileHash .\Limit-Tracker-<version>.exe -Algorithm SHA256` in PowerShell. A match shows the file is the one on the release page, not that it was built from this source.
- Read the source and build it yourself (see the README). An installed build of your own still downloads new releases from this repository, and choosing to install one replaces your build with the published installer. Turn **Check for new versions** off to stay on your own build.
