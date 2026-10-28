> [!TIP]
> **Want it to run locally, on just your own computer?** Go to the **[Local Edition →](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local)**. It has the same 211 tools, with no ngrok, no password and about 5 minutes of setup.

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://fireiscoolsolo.github.io/canvas-lms-mcp-server/logo-dark.png">
  <img src="https://fireiscoolsolo.github.io/canvas-lms-mcp-server/logo.png" width="128" alt="Canvas LMS MCP: Remote Edition logo">
</picture>

# Canvas LMS MCP: Remote Edition

**Use Canvas from your AI assistant on any device: web, desktop and mobile. Always on, password-protected, with automatic failover across several computers.**

211 tools · OAuth 2.1 · ngrok tunnel · Multi-computer failover

[![npm](https://img.shields.io/npm/v/canvas-lms-mcp-remote?logo=npm&color=CB3837)](https://www.npmjs.com/package/canvas-lms-mcp-remote)
[![npm downloads](https://img.shields.io/npm/dt/canvas-lms-mcp-remote?label=npm%20downloads&logo=npm&color=CB3837)](https://www.npmjs.com/package/canvas-lms-mcp-remote)
[![npm downloads per month](https://img.shields.io/npm/dm/canvas-lms-mcp-remote?label=npm%2Fmonth&color=CB3837)](https://npm-stat.com/charts.html?package=canvas-lms-mcp-remote)
[![Release downloads](https://img.shields.io/github/downloads/Fireiscoolsolo/canvas-lms-mcp-server/total?label=release%20downloads&logo=github)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/releases)
[![Tests](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/actions/workflows/test.yml/badge.svg)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/actions/workflows/test.yml)
[![Glama score](https://glama.ai/mcp/servers/Fireiscoolsolo/canvas-lms-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/Fireiscoolsolo/canvas-lms-mcp-server)
[![GitHub stars](https://img.shields.io/github/stars/Fireiscoolsolo/canvas-lms-mcp-server?logo=github)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/stargazers)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/docs-website-orange)](https://fireiscoolsolo.github.io/canvas-lms-mcp-server/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

[Website](https://fireiscoolsolo.github.io/canvas-lms-mcp-server/) · [Quick start](#quick-start) · [**Multi-device guide**](MULTI_DEVICE.md) · [Configuration](#configuration) · [Tools](#tools) · [Security](#security)

</div>

<p align="center"><img src="https://fireiscoolsolo.github.io/canvas-lms-mcp-server/demo.svg" width="760" alt="Example chat: asking what score is needed on the final and what's due this week (sample data)"></p>

---

## Remote or Local?

| | **Remote** (this repo) | [**Local**](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local) |
|---|---|---|
| Works with | Any MCP client that supports remote servers, **on any device** | Desktop and command-line MCP clients **on this computer** |
| When it runs | Always on, in the background | Only while your AI app is open |
| You need | Node.js, a Canvas token, an ngrok account and a password | Node.js and a Canvas token |
| Internet exposure | Public HTTPS address, password-protected | None |
| Multiple computers | Automatic failover ([guide](MULTI_DEVICE.md)) | Install it separately on each one |

## Highlights

- **Grade intelligence**: `what_if_grade`, `compute_needed_score`, `grade_impact_ranking`, `calculate_gpa`, full weighted breakdowns
- **Planning**: `get_week_ahead`, `semester_snapshot`, `study_priority_ranking`, cross-course missing work in one call
- **Submissions**: submit text, URLs and files, with a dry-run preview first
- **Discussions & inbox**: read whole threads in one request and message instructors
- **Content**: read lecture PDFs, Word docs and slides with `read_course_file`, plus pages, modules, captions and full `.imscc` course export
- **Prompts and attachments**: one-click prompts like *Plan my week* and *Prep me for an exam*, and attach a syllabus or assignment to a chat
- **Phone alerts**: new grades, announcements, work due soon and an expiring token, sent to your phone or Discord
- **Secure remote access**: password-gated OAuth 2.1 over an ngrok tunnel
- **Multi-computer failover**: run it on two or more computers, and if one sleeps, another takes over in about a minute

## How it works

```
 Your AI app (web / desktop / mobile / CLI)
          │  HTTPS + OAuth
          ▼
   your-domain.ngrok-free.dev ──►  supervisor.js  ──►  index.js (127.0.0.1:3939/mcp)  ──►  Canvas API
                                   (keeps it alive,     (211 tools, OAuth,
                                    failover)            rate-limit aware)
```

## Quick start

> [!NOTE]
> **Rather click than type?** Download the **[Canvas MCP Installer Assistant for Windows](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/releases/download/v1.2.0/CanvasMCPInstallerAssistant-Setup-0.3.0.exe)** (115 MB). It walks you through these steps with pictures and checks each one as you go, for both the Remote and Local editions.
>
> Windows may show "Windows protected your PC" because the app isn't code-signed yet. Click **More info**, then **Run anyway**.

**You need:** [Node.js 18+](https://nodejs.org), a Canvas account and a free [ngrok](https://ngrok.com) account.

### 1. Install
**With npm (easiest):**
```bash
npm install -g canvas-lms-mcp-remote
mkdir canvas-mcp
cd canvas-mcp
canvas-lms-mcp-remote init
```
That folder is your **settings folder**. It holds your `.env`, logins and logs, so run every later step from it.

**Or from source:** `git clone https://github.com/Fireiscoolsolo/canvas-lms-mcp-server.git`, then run `npm install` inside the folder. No git? Download the zip from the [latest release](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/releases/latest) instead. The repo folder is then your settings folder.

<details>
<summary><b>All commands</b></summary>

| Command | What it does |
|---|---|
| `canvas-lms-mcp-remote init` | Create a `.env` template in the current folder |
| `canvas-lms-mcp-remote` | Start the supervisor: server, ngrok tunnel and failover |
| `canvas-lms-mcp-remote serve` | Start only the HTTP server on `127.0.0.1` (no tunnel) |
| `canvas-lms-mcp-remote --stdio` | Serve over stdin/stdout, for directories that inspect servers |

From source, use `node supervisor.js` and `node index.js` instead.
</details>

### 2. Create a Canvas token
In Canvas, go to **Account → Settings → Approved Integrations → + New Access Token**. Canvas only shows the token once, so copy it right away.

### 3. Set up ngrok
```powershell
winget install --id Ngrok.Ngrok -e
ngrok update                                   # the winget version is often too old (ERR_NGROK_121)
ngrok config add-authtoken <your-ngrok-authtoken>
```
Then claim your free **static domain** in the [ngrok dashboard](https://dashboard.ngrok.com), e.g. `your-name.ngrok-free.dev`.

### 4. Configure `.env`
Fill in the `.env` that `init` created. From source, copy `.env.example` to `.env` first. Generate the password and secret with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 5. Test it
```bash
canvas-lms-mcp-remote
```
From source, run `node supervisor.js` instead.
Wait until you see `active and serving at https://…`, then press Ctrl+C.

### 6. Run it automatically at logon (Windows)
In PowerShell, **from your settings folder** (the repo folder, if you installed from source):
```powershell
$dir      = (Get-Location).Path
$action   = New-ScheduledTaskAction -Execute "$dir\run-supervisor.cmd" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName CanvasSupervisor -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName CanvasSupervisor
```
**Installed from npm?** Use this `$action` line instead:
```powershell
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c call "%APPDATA%\npm\canvas-lms-mcp-remote.cmd" >> supervisor.log 2>&1' -WorkingDirectory $dir
```
`run-supervisor.cmd` assumes Node is at `C:\Program Files\nodejs\node.exe`. If yours is somewhere else, edit that file. On Linux, run it as a systemd user service ([example](MULTI_DEVICE.md#linux-run-it-as-a-systemd-user-service)). On macOS, run `node supervisor.js` under launchd or pm2.

### 7. Connect your AI app, on every device
In your AI app's settings, add a **custom connector** (also called a *remote MCP server*) with the URL `https://<your-domain>/mcp`, then log in with your password. Apps that sync connectors to your account will show it on your phone and desktop too. Command-line and editor clients can add it as an **HTTP** MCP server with the same URL.

Then ask your assistant: **"Run test_connection."**

## Multiple computers

You can run the same server on two or more computers, for example a desktop and a laptop, so it stays online when one is off or asleep. One computer serves; the others wait in standby and take over automatically.

**Follow the step-by-step [Multi-Device Setup Guide](MULTI_DEVICE.md).** It covers copying settings safely, the shared ngrok account, the scheduled task, checking it works, testing failover, updating code and changing secrets.

## Configuration

All settings are environment variables in `.env`. See [`.env.example`](.env.example).

| Variable | Required | Default | Description |
|---|:-:|---|---|
| `CANVAS_API_TOKEN` | Yes | — | Your Canvas personal access token |
| `CANVAS_BASE_URL` | Yes | — | e.g. `https://yourschool.instructure.com` |
| `CANVAS_MCP_PUBLIC_URL` | Yes | — | Your ngrok static domain |
| `CANVAS_MCP_PASSWORD` | Yes | — | Password for the OAuth login page |
| `CANVAS_MCP_CLUSTER_SECRET` | Yes | — | Secret that protects the `/internal/*` endpoints the computers use to coordinate |
| `CANVAS_ALLOW_WRITES` | | `true` | `false` = read-only mode |
| `CANVAS_PROFILE` | | `full` | `core` = curated subset of tools |
| `CANVAS_CACHE_TTL` | | `60` | Response cache time in seconds |
| `CANVAS_TIMEZONE` | | system | IANA time zone for due-date math |
| `CANVAS_DOWNLOAD_DIR` | | `./canvas-downloads` | Where download tools save files |
| `CANVAS_MCP_HOST` / `_PORT` | | `127.0.0.1` / `3939` | Bind address |
| `CANVAS_MCP_OAUTH_STORE_PATH` | | `./oauth-store.json` | Token store |
| `CANVAS_MCP_NGROK_PATH` | | winget path | Path to `ngrok.exe` |
| `CANVAS_MCP_TRANSPORT` | | `http` | `stdio` (or the `--stdio` flag) serves over stdin/stdout instead of HTTP. Used by directories that inspect servers. For everyday local use, see the [Local Edition](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local) |
| `CANVAS_ALERTS_NTFY_TOPIC` | | — | ntfy topic for [phone alerts](#phone-alerts). Treat it like a password |
| `CANVAS_ALERTS_DISCORD_WEBHOOK` | | — | Discord webhook URL for [phone alerts](#phone-alerts) |
| `CANVAS_ALERTS` | | all | Which alerts to send: `grades,announcements,due,token` |
| `CANVAS_ALERTS_DUE_HOURS` | | `24` | How far ahead "due soon" alerts look |
| `CANVAS_ALERTS_INTERVAL_MINUTES` | | `15` | How often to check for alerts (at least 5) |
| `CANVAS_ALERTS_NTFY_SERVER` | | `https://ntfy.sh` | Your own ntfy server, if you run one |

## Tools

| Group | Count | Highlights |
|---|:-:|---|
| Identity | 25 | `check_token_expiry`, `get_rate_limit_status`, custom-data storage |
| Courses | 16 | permissions, nicknames, favorites |
| Assignments | 12 | `list_missing_submissions`, `get_late_policy` |
| Submissions | 16 | text, URL and file submission, comments, rubric assessments |
| Grades | 14 | `what_if_grade`, `compute_needed_score`, `grade_impact_ranking`, `calculate_gpa` |
| Quizzes | 12 | read-only: dates, attempts, reviews |
| Discussions | 17 | `get_full_topic_view`, replies, ratings |
| Inbox | 14 | messaging, `find_recipients`, threads |
| Calendar | 11 | events, office-hours booking |
| Content | 34 | files, pages, modules, captions, `read_course_file` for PDF, Word and PowerPoint, `.imscc` export |
| Groups | 11 | group workspaces |
| Rubrics | 11 | peer reviews |
| Search | 3 | `smart_search` with keyword fallback |
| Planning | 11 | `get_week_ahead`, `semester_snapshot`, `study_priority_ranking` |
| Meta | 4 | `raw_canvas_request` for any endpoint not listed above |

### Prompts and attachments

The server also adds these to your AI app's menus. They don't count as tools.

- **Prompts**: *Plan my week*, *What did I miss?*, *Prep me for an exam*, *How are my grades?* and *Catch me up on a course*. Each one tells the assistant which tools to use, and course names autocomplete.
- **Attachments**: attach a course syllabus, or an assignment due in the next 14 days, to a chat the same way you'd attach a file.

Apps that support MCP prompts and resources, such as Claude Desktop, show them in the **+** menu.

## Phone alerts

Because the Remote Edition is always on, it can tell you when something happens:

- **New grades** (several at once arrive as one summary)
- **New announcements**
- **Work due within 24 hours** that you haven't submitted yet
- **A Canvas token that expires within 5 days**

Alerts are off until you choose where they go. Add one or both to `.env`, then restart the server:

- **Phone app:** install the free [ntfy](https://ntfy.sh) app, subscribe to a long, hard-to-guess topic name (it works like a password), and set `CANVAS_ALERTS_NTFY_TOPIC` to it.
- **Discord:** in a private Discord server, open a channel's **Settings → Integrations → Webhooks**, create one and set `CANVAS_ALERTS_DISCORD_WEBHOOK` to its URL.

Then run `canvas-lms-mcp-remote test-alert` from your settings folder to check it works. To choose which alerts you get, see `CANVAS_ALERTS` in [Configuration](#configuration).

Only the computer that is serving sends alerts, and it remembers what it already sent in your Canvas account's own storage, so you don't get repeats when another computer takes over. Alert text passes through ntfy or Discord, so keep the topic or channel private.

## Security

- **Confirmation gate:** tools that send, submit, post or delete return a preview first and only act when called with `confirm: true`.
- **Prompt-injection fencing:** text other people wrote is wrapped in `<<<CANVAS_CONTENT>>>` markers and labelled as untrusted.
- **No quiz-taking:** quiz attempt endpoints are deliberately not included.
- **Loopback only:** the server listens on `127.0.0.1`. The only way in from outside is the tunnel.
- **OAuth 2.1:** login is limited to 10 attempts per 15 minutes per IP, access tokens last 1 hour, and refresh tokens are replaced every time they're used.
- **Separate coordination secret:** the endpoints the computers use to coordinate need a separate shared secret, compared in constant time.

> **Never commit** `.env`, `oauth-store.json` or `supervisor.log`. They're already listed in `.gitignore`. See [SECURITY.md](SECURITY.md).

## Responsible use

This is a study and organization tool. It helps you see deadlines, understand your grades and plan your week. It never takes quizzes, and nothing is sent or submitted until you've seen a preview and confirmed it.

- Follow your school's academic integrity and acceptable-use policies. Some schools restrict personal API tokens or third-party tools.
- Want zero risk of accidental changes? Set `CANVAS_ALLOW_WRITES=false` for read-only mode.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ERR_NGROK_121` | Your ngrok version is too old. Run `ngrok update` |
| `ERR_NGROK_334 … already online` | Another computer or a leftover `ngrok.exe` holds the domain. This is normal for a standby computer |
| `ERR_NGROK_3200` (endpoint offline) | No computer is serving. Check `supervisor.log` |
| ngrok shows a "You are about to visit…" page at login | This is normal on the free plan. Click **Visit Site** |
| `startup probe failed` | Check `CANVAS_BASE_URL` and your internet connection |
| Canvas returns 401 | Your token expired. Create a new one |
| New tools don't show up | Reconnect the connector or restart your AI app |

More issues with several computers are covered in the [Multi-Device guide](MULTI_DEVICE.md#troubleshooting).

**Restart cleanly.** `Stop-ScheduledTask` alone can leave processes running:
```powershell
Stop-ScheduledTask -TaskName CanvasSupervisor -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'supervisor\.js|index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Start-ScheduledTask -TaskName CanvasSupervisor
```

**Known limits:** a student token can't reach admin endpoints, gradebook history, course analytics or quiz statistics. `smart_search` is a Canvas beta feature and often returns 404.

## License

[MIT](LICENSE). This project isn't affiliated with Instructure.
