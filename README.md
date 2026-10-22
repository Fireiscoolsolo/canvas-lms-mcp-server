> [!TIP]
> **Want it to run locally, on just your own computer?** Go to the **[💻 Local Edition →](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local)**. It has the same 209 tools, with no ngrok, no password and about 5 minutes of setup.

<div align="center">

# 🌐 Canvas LMS MCP: Remote Edition

**Use Canvas from your AI assistant on any device: web, desktop and mobile. Always on, password-protected, with automatic failover across several computers.**

209 tools · OAuth 2.1 · ngrok tunnel · Multi-computer failover

[![Downloads](https://img.shields.io/github/downloads/Fireiscoolsolo/canvas-lms-mcp-server/total?label=downloads&logo=github)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/releases)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/docs-website-orange)](https://fireiscoolsolo.github.io/canvas-lms-mcp-server/)

[Website](https://fireiscoolsolo.github.io/canvas-lms-mcp-server/) · [Quick start](#-quick-start) · [**Multi-device guide**](MULTI_DEVICE.md) · [Configuration](#%EF%B8%8F-configuration) · [Tools](#-tools) · [Security](#-security)

</div>

<p align="center"><img src="https://fireiscoolsolo.github.io/canvas-lms-mcp-server/demo.svg" width="760" alt="Example chat: asking what score is needed on the final and what's due this week (sample data)"></p>

---

## 🤔 Remote or Local?

| | 🌐 **Remote** (this repo) | 💻 [**Local**](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local) |
|---|---|---|
| Works with | Any MCP client that supports remote servers, **on any device** | Desktop and command-line MCP clients **on this computer** |
| When it runs | Always on, in the background | Only while your AI app is open |
| You need | Node.js, a Canvas token, an ngrok account and a password | Node.js and a Canvas token |
| Internet exposure | Public HTTPS address, password-protected | None |
| Multiple computers | ✅ Automatic failover ([guide](MULTI_DEVICE.md)) | Install it separately on each one |

## ✨ Highlights

- **📊 Grade intelligence**: `what_if_grade`, `compute_needed_score`, `grade_impact_ranking`, full weighted breakdowns
- **📅 Planning**: `get_week_ahead`, `semester_snapshot`, `study_priority_ranking`, cross-course missing work in one call
- **📝 Submissions**: submit text, URLs and files, with a dry-run preview first
- **💬 Discussions & inbox**: read whole threads in one request and message instructors
- **📁 Content**: files, pages, modules, lecture captions and full `.imscc` course export
- **🔐 Secure remote access**: password-gated OAuth 2.1 over an ngrok tunnel
- **🔁 Multi-computer failover**: run it on two or more computers, and if one sleeps, another takes over in about a minute

## 🧭 How it works

```
 Your AI app (web / desktop / mobile / CLI)
          │  HTTPS + OAuth
          ▼
   your-domain.ngrok-free.dev ──►  supervisor.js  ──►  index.js (127.0.0.1:3939/mcp)  ──►  Canvas API
                                   (keeps it alive,     (209 tools, OAuth,
                                    failover)            rate-limit aware)
```

## 🚀 Quick start

**You need:** [Node.js 18+](https://nodejs.org), a Canvas account and a free [ngrok](https://ngrok.com) account.

### 1. Download and install
```bash
git clone https://github.com/Fireiscoolsolo/canvas-lms-mcp-server.git
cd canvas-lms-mcp-server
npm install
```
No git? Download the zip from the [latest release](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/releases/latest), unzip it, and run `npm install` inside the folder.

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
Copy `.env.example` to `.env` and fill it in. Generate the password and secret with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 5. Test it
```bash
node supervisor.js
```
Wait until you see `active and serving at https://…`, then press Ctrl+C.

### 6. Run it automatically at logon (Windows)
In PowerShell, **from the repo folder**:
```powershell
$dir      = (Get-Location).Path
$action   = New-ScheduledTaskAction -Execute "$dir\run-supervisor.cmd" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName CanvasSupervisor -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName CanvasSupervisor
```
`run-supervisor.cmd` assumes Node is at `C:\Program Files\nodejs\node.exe`. If yours is somewhere else, edit that file. On Linux, run it as a systemd user service ([example](MULTI_DEVICE.md#linux-run-it-as-a-systemd-user-service)). On macOS, run `node supervisor.js` under launchd or pm2.

### 7. Connect your AI app, on every device
In your AI app's settings, add a **custom connector** (also called a *remote MCP server*) with the URL `https://<your-domain>/mcp`, then log in with your password. Apps that sync connectors to your account will show it on your phone and desktop too. Command-line and editor clients can add it as an **HTTP** MCP server with the same URL.

Then ask your assistant: **"Run test_connection."**

## 🔁 Multiple computers

You can run the same server on two or more computers, for example a desktop and a laptop, so it stays online when one is off or asleep. One computer serves; the others wait in standby and take over automatically.

**➡️ Follow the step-by-step [Multi-Device Setup Guide](MULTI_DEVICE.md).** It covers copying settings safely, the shared ngrok account, the scheduled task, checking it works, testing failover, updating code and changing secrets.

## ⚙️ Configuration

All settings are environment variables in `.env`. See [`.env.example`](.env.example).

| Variable | Required | Default | Description |
|---|:-:|---|---|
| `CANVAS_API_TOKEN` | ✅ | — | Your Canvas personal access token |
| `CANVAS_BASE_URL` | ✅ | — | e.g. `https://yourschool.instructure.com` |
| `CANVAS_MCP_PUBLIC_URL` | ✅ | — | Your ngrok static domain |
| `CANVAS_MCP_PASSWORD` | ✅ | — | Password for the OAuth login page |
| `CANVAS_MCP_CLUSTER_SECRET` | ✅ | — | Secret that protects the `/internal/*` endpoints the computers use to coordinate |
| `CANVAS_ALLOW_WRITES` | | `true` | `false` = read-only mode |
| `CANVAS_PROFILE` | | `full` | `core` = curated subset of tools |
| `CANVAS_CACHE_TTL` | | `60` | Response cache time in seconds |
| `CANVAS_TIMEZONE` | | system | IANA time zone for due-date math |
| `CANVAS_DOWNLOAD_DIR` | | `./canvas-downloads` | Where download tools save files |
| `CANVAS_MCP_HOST` / `_PORT` | | `127.0.0.1` / `3939` | Bind address |
| `CANVAS_MCP_OAUTH_STORE_PATH` | | `./oauth-store.json` | Token store |
| `CANVAS_MCP_NGROK_PATH` | | winget path | Path to `ngrok.exe` |

## 🧰 Tools

| Group | Count | Highlights |
|---|:-:|---|
| Identity | 24 | `check_token_expiry`, `get_rate_limit_status`, custom-data storage |
| Courses | 16 | permissions, nicknames, favorites |
| Assignments | 12 | `list_missing_submissions`, `get_late_policy` |
| Submissions | 16 | text, URL and file submission, comments, rubric assessments |
| Grades | 13 | `what_if_grade`, `compute_needed_score`, `grade_impact_ranking` |
| Quizzes | 12 | read-only: dates, attempts, reviews |
| Discussions | 17 | `get_full_topic_view`, replies, ratings |
| Inbox | 14 | messaging, `find_recipients`, threads |
| Calendar | 11 | events, office-hours booking |
| Content | 33 | files, pages, modules, captions, `.imscc` export |
| Groups | 11 | group workspaces |
| Rubrics | 11 | peer reviews |
| Search | 3 | `smart_search` with keyword fallback |
| Planning | 11 | `get_week_ahead`, `semester_snapshot`, `study_priority_ranking` |
| Meta | 4 | `raw_canvas_request` for any endpoint not listed above |

## 🔐 Security

- **Confirmation gate:** tools that send, submit, post or delete return a preview first and only act when called with `confirm: true`.
- **Prompt-injection fencing:** text other people wrote is wrapped in `<<<CANVAS_CONTENT>>>` markers and labelled as untrusted.
- **No quiz-taking:** quiz attempt endpoints are deliberately not included.
- **Loopback only:** the server listens on `127.0.0.1`. The only way in from outside is the tunnel.
- **OAuth 2.1:** login is limited to 10 attempts per 15 minutes per IP, access tokens last 1 hour, and refresh tokens are replaced every time they're used.
- **Separate coordination secret:** the endpoints the computers use to coordinate need a separate shared secret, compared in constant time.

> **Never commit** `.env`, `oauth-store.json` or `supervisor.log`. They're already listed in `.gitignore`. See [SECURITY.md](SECURITY.md).

## 🎓 Responsible use

This is a study and organization tool. It helps you see deadlines, understand your grades and plan your week. It never takes quizzes, and nothing is sent or submitted until you've seen a preview and confirmed it.

- Follow your school's academic integrity and acceptable-use policies. Some schools restrict personal API tokens or third-party tools.
- Want zero risk of accidental changes? Set `CANVAS_ALLOW_WRITES=false` for read-only mode.

## 🛠️ Troubleshooting

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

## 📄 License

[MIT](LICENSE). This project isn't affiliated with Instructure.
