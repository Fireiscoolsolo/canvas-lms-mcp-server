> [!TIP]
> **Want it to run locally, on just your own computer?** Go to the **[Local Edition →](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local)** ([website](https://fireiscoolsolo.github.io/canvas-lms-mcp-local/)). It has the same 242 tools, with no tunnel, no password and a one-command setup.

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://fireiscoolsolo.github.io/canvas-lms-mcp-server/logo-dark.png">
  <img src="https://fireiscoolsolo.github.io/canvas-lms-mcp-server/logo.png" width="128" alt="Canvas LMS MCP: Remote Edition logo">
</picture>

# Canvas LMS MCP: Remote Edition

**Use Canvas from your AI assistant on any device: web, desktop and mobile. Always on, password-protected, with automatic failover across several computers.**

242 tools · OAuth 2.1 · Status page · Phone alerts · ngrok or Cloudflare tunnel · Multi-computer failover

[![npm](https://img.shields.io/npm/v/canvas-lms-mcp-remote?logo=npm&color=CB3837)](https://www.npmjs.com/package/canvas-lms-mcp-remote)
[![npm downloads](https://img.shields.io/npm/dt/canvas-lms-mcp-remote?label=npm%20downloads&logo=npm&color=CB3837)](https://www.npmjs.com/package/canvas-lms-mcp-remote)
[![npm downloads per month](https://img.shields.io/npm/dm/canvas-lms-mcp-remote?label=npm%2Fmonth&color=CB3837)](https://npm-stat.com/charts.html?package=canvas-lms-mcp-remote)
[![Release downloads](https://img.shields.io/github/downloads/Fireiscoolsolo/canvas-lms-mcp-server/total?label=release%20downloads&logo=github)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/releases)
[![Tests](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/actions/workflows/test.yml/badge.svg)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/actions/workflows/test.yml)
[![Windows app](https://img.shields.io/badge/Windows%20app-free-5B4BDB?logo=windows&logoColor=white)](https://fireiscoolsolo.github.io/canvas-lms-mcp-local/app/)
[![Glama score](https://glama.ai/mcp/servers/Fireiscoolsolo/canvas-lms-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/Fireiscoolsolo/canvas-lms-mcp-server)
[![GitHub stars](https://img.shields.io/github/stars/Fireiscoolsolo/canvas-lms-mcp-server?logo=github)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/stargazers)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/docs-website-orange)](https://fireiscoolsolo.github.io/canvas-lms-mcp-server/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/Fireiscoolsolo/canvas-lms-mcp-server/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

[Website](https://fireiscoolsolo.github.io/canvas-lms-mcp-server/) · [Quick start](#quick-start) · [**Multi-device guide**](MULTI_DEVICE.md) · [Configuration](#configuration) · [Tools](#tools) · [Phone alerts](#phone-alerts) · [Security](#security) · [Changelog](CHANGELOG.md)

</div>

> [!TIP]
> **On Windows? Skip the terminal.** The free **[Canvas MCP Installer Assistant](https://fireiscoolsolo.github.io/canvas-lms-mcp-local/app/)** sets this up for Claude or the ChatGPT desktop app with pictures and a check after every step, or does every step for you. **[Download for Windows](https://fireiscoolsolo.github.io/canvas-lms-mcp-local/download/)**

<p align="center"><img src="https://fireiscoolsolo.github.io/canvas-lms-mcp-server/demo.svg" width="760" alt="Example chat: asking what score is needed on the final and what's due this week (sample data)"></p>

---

## Remote or Local?

| | **Remote** (this repo) | [**Local**](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local) |
|---|---|---|
| Works with | Any MCP client that supports remote servers, **on any device** | Claude Desktop, the ChatGPT desktop app and other MCP clients **on this computer** |
| When it runs | Always on, in the background | Only while your AI app is open |
| You need | Node.js (or Docker), a Canvas token, an ngrok or Cloudflare account and a password | Node.js and a Canvas token |
| Internet exposure | Public HTTPS address, password-protected | None |
| Multiple computers | Automatic failover ([guide](MULTI_DEVICE.md)) | Install it separately on each one |

## Highlights

- **Your day and week**: `daily_briefing`, `get_week_ahead`, `semester_snapshot`, planner notes, checking items off your To Do list
- **Study plans**: `study_plan` spreads study time before each deadline; `schedule_study_plan` puts it on your Canvas calendar
- **Grade intelligence**: `final_grade_scenarios`, `what_if_grade`, `grade_impact_ranking`, `calculate_gpa`, full weighted breakdowns
- **Assignments, submissions, discussions and inbox**: `assignment_brief` in one call; submit, post and message after a preview
- **Content**: read lecture PDFs, Word docs and slides with `read_course_file`; downloads come back as links your phone can open
- **Phone alerts**: new grades, announcements, work due soon, new assignments, teacher comments, messages and more, by ntfy, Discord, Telegram, Slack, Teams or Pushover, instantly or as a daily digest
- **Status page**: see from any browser whether your server is online, who is signed in, and sign apps out
- **Secure remote access**: password-gated OAuth 2.1 with lockout, a login history and optional two-factor codes, over an ngrok or Cloudflare tunnel
- **Multi-computer failover**: run it on two or more computers, and if one sleeps, another takes over in about a minute

## How it works

```
 Your AI app (web / desktop / mobile / CLI)
          │  HTTPS + OAuth
          ▼
   your-domain.ngrok-free.dev ──►  supervisor.js  ──►  index.js (127.0.0.1:3939/mcp)  ──►  Canvas API
   (or a Cloudflare hostname)      (keeps it alive,     (242 tools, OAuth, status page,
                                    failover)            phone alerts)
```

## Quick start

> [!NOTE]
> **Rather click than type?** Download the **[Canvas MCP Installer Assistant for Windows](https://fireiscoolsolo.github.io/canvas-lms-mcp-local/download/)**. It walks you through these steps with pictures and checks each one as you go, for both the Remote and Local editions. [See screenshots](https://fireiscoolsolo.github.io/canvas-lms-mcp-local/app/).
>
> Windows may show "Windows protected your PC" because the app isn't code-signed yet. Click **More info**, then **Run anyway**.

**You need:** [Node.js 18+](https://nodejs.org) (22+ to read PDFs), a Canvas account and a free [ngrok](https://ngrok.com) account (or a [Cloudflare](https://www.cloudflare.com) account with your own domain). Prefer containers? See [Docker](#docker).

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
| `canvas-lms-mcp-remote` | Start the supervisor: server, tunnel and failover |
| `canvas-lms-mcp-remote serve` | Start only the HTTP server on `127.0.0.1` (no tunnel) |
| `canvas-lms-mcp-remote install-service` | Start it automatically when you sign in (Windows, Linux or macOS) |
| `canvas-lms-mcp-remote uninstall-service` | Stop starting it automatically |
| `canvas-lms-mcp-remote stop` / `restart` | Stop the running supervisor, or stop and start it again |
| `canvas-lms-mcp-remote status` | Is it running, which computer is serving, who is signed in |
| `canvas-lms-mcp-remote logs [-f]` | Show the end of `supervisor.log` (`-f` keeps following it) |
| `canvas-lms-mcp-remote doctor` | Check settings, token, tunnel and startup service, and say how to fix problems |
| `canvas-lms-mcp-remote test-alert` | Send a test phone alert |
| `canvas-lms-mcp-remote sessions [sign-out <id> \| sign-out-all \| tidy]` | List or sign out connected apps |
| `canvas-lms-mcp-remote rotate-password` | Make a new password and sign every app out |
| `canvas-lms-mcp-remote totp-setup` / `totp-off` | Turn two-factor codes on or off |
| `canvas-lms-mcp-remote cluster` | List the computers in your group |
| `canvas-lms-mcp-remote takeover` | Make this computer the one that serves |
| `canvas-lms-mcp-remote profile [name]` | Show the [tool profiles](#tool-profiles), or switch to one (then restart) |
| `canvas-lms-mcp-remote uninstall` | Stop it, remove the startup service and say how to remove the package |
| `canvas-lms-mcp-remote --stdio` | Serve over stdin/stdout, for directories that inspect servers |

From source, use `node cli.js <command>` instead.
</details>

### 2. Create a Canvas token
In Canvas, go to **Account → Settings → Approved Integrations → + New Access Token**. Canvas only shows the token once, so copy it right away.

### 3. Set up a tunnel
**ngrok (default).** On Windows:
```powershell
winget install --id Ngrok.Ngrok -e
ngrok update                                   # the winget version is often too old (ERR_NGROK_121)
ngrok config add-authtoken <your-ngrok-authtoken>
```
On a Mac, with [Homebrew](https://brew.sh):
```bash
brew install ngrok
ngrok config add-authtoken <your-ngrok-authtoken>
```
On Linux, install it from [ngrok's download page](https://ngrok.com/download), then run the same `ngrok config add-authtoken` line.

The server finds ngrok by itself: the winget install on Windows, and on a Mac or Linux your `PATH` plus the folders Homebrew, snap and the usual installers use. If yours is somewhere else, put its full path in `CANVAS_MCP_NGROK_PATH`.

Then claim your free **static domain** in the [ngrok dashboard](https://dashboard.ngrok.com), e.g. `your-name.ngrok-free.dev`.

<details>
<summary><b>Or Cloudflare Tunnel (no "Visit Site" page, your own domain)</b></summary>

1. Install `cloudflared` ([downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/); on Windows `winget install --id Cloudflare.cloudflared`, on a Mac `brew install cloudflared`). The server finds it the same way as ngrok, or set `CANVAS_MCP_CLOUDFLARED_PATH`.
2. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels**, create a tunnel and copy its **token**.
3. Add a **public hostname** to the tunnel, e.g. `canvas.yourdomain.com`, pointing at `http://localhost:3939`.
4. In `.env`, set `CANVAS_MCP_TUNNEL=cloudflared`, `CANVAS_MCP_CLOUDFLARED_TOKEN=<token>` and `CANVAS_MCP_PUBLIC_URL=https://canvas.yourdomain.com`.

Using your own reverse proxy or Tailscale Funnel instead? Set `CANVAS_MCP_TUNNEL=none` and point it at port 3939.
</details>

### 4. Configure `.env`
Fill in the `.env` that `init` created. From source, copy `.env.example` to `.env` first. Generate the password and secret with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 5. Test it
```bash
canvas-lms-mcp-remote doctor
canvas-lms-mcp-remote
```
`doctor` checks your settings, token and tunnel first. Then wait until you see `active and serving at https://…`, and press Ctrl+C.

### 6. Run it automatically when you sign in
```bash
canvas-lms-mcp-remote install-service
```
On Windows this creates the `CanvasSupervisor` scheduled task, on Linux a systemd user service, and on macOS a launch agent. All of them restart it if it crashes and write `supervisor.log` in your settings folder, rotating it at 5 MB.

<details>
<summary><b>Setting up the Windows task by hand</b></summary>

In PowerShell, **from your settings folder** (the repo folder, if you installed from source):
```powershell
$dir      = (Get-Location).Path
$action   = New-ScheduledTaskAction -Execute "$dir\run-supervisor.cmd" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName CanvasSupervisor -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName CanvasSupervisor
```
`run-supervisor.cmd` assumes Node is at `C:\Program Files\nodejs\node.exe`. If yours is somewhere else, edit that file.
</details>

On a Mac, `install-service` creates a launch agent in `~/Library/LaunchAgents`. A Mac that sleeps stops serving, and another computer in your group takes over. To keep it awake while it's plugged in, turn on **Prevent automatic sleeping on power adapter when the display is off** (System Settings → Battery → Options; on a desktop Mac, System Settings → Energy).

### 7. Connect your AI app, on every device
In your AI app's settings, add a **custom connector** (also called a *remote MCP server*) with the URL `https://<your-domain>/mcp`, then log in with your password. Apps that sync connectors to your account will show it on your phone and desktop too. Command-line and editor clients can add it as an **HTTP** MCP server with the same URL.

<details>
<summary><b>ChatGPT desktop app</b></summary>

1. Open **Settings → Plugins**, go to the **MCPs** tab, then click **Add → Add MCP server**.
2. Choose **Streamable HTTP** and fill in the form:

   | Field | Value |
   |---|---|
   | Name | `canvas-remote` |
   | URL | `https://<your-domain>/mcp` |
   | Headers | `ngrok-skip-browser-warning` = `1` |

3. Click **Save**, then **Authenticate** and log in with your password. Start a **new chat** to use it.

The header skips the page ngrok's free plan shows before your server.
</details>

Then ask your assistant: **"Run test_connection."**

## Status page

Open **`https://<your-domain>/status`** in any browser and enter your password. It shows whether the server is online and which computer is serving, your Canvas connection and when the token expires, the apps that are signed in (each with a **Sign out** button), recent sign-ins, the computers in your group, your phone-alert settings and recent problems. Nothing secret is ever shown, and the page locks itself after 12 hours, or when the server restarts. **Lock** ends that sign-in everywhere. Wrong passwords here count toward the same lockout as the login page, and show up in recent sign-ins.

From a terminal, `canvas-lms-mcp-remote status` and `canvas-lms-mcp-remote sessions` show the same things.

## Multiple computers

You can run the same server on two or more computers, for example a desktop and a laptop, so it stays online when one is off or asleep. One computer serves; the others wait in standby and take over automatically.

**Follow the step-by-step [Multi-Device Setup Guide](MULTI_DEVICE.md).** It covers copying settings safely, the shared tunnel, the startup service, checking it works, testing failover, updating code and changing secrets. `canvas-lms-mcp-remote cluster` lists the computers, and `canvas-lms-mcp-remote takeover` moves serving to the computer you're on.

## Docker

For a home server or NAS: copy `.env.example` to `.env`, fill it in with your own password and cluster secret (the server won't start with the example values), add `NGROK_AUTHTOKEN=<your ngrok authtoken>`, then:

```bash
docker compose up -d
```

[`docker-compose.yml`](docker-compose.yml) runs the server and an ngrok tunnel, keeping your logins in a Docker volume. It also has a commented-out Cloudflare Tunnel service to use instead. One container serves, so there's no failover between computers in this setup; Docker restarts it if it stops.

## Configuration

All settings are environment variables in `.env`. See [`.env.example`](.env.example).

| Variable | Required | Default | Description |
|---|:-:|---|---|
| `CANVAS_API_TOKEN` | Yes | — | Your Canvas personal access token |
| `CANVAS_BASE_URL` | Yes | — | e.g. `https://yourschool.instructure.com` |
| `CANVAS_MCP_PUBLIC_URL` | Yes | — | Your public address (ngrok static domain or Cloudflare hostname) |
| `CANVAS_MCP_PASSWORD` | Yes | — | Password for the login and status pages. Use 12 or more characters |
| `CANVAS_MCP_CLUSTER_SECRET` | Yes | — | Secret that protects the `/internal/*` endpoints the computers use to coordinate. At least 16 random characters |
| `CANVAS_MCP_TOTP_SECRET` | | — | Turns on two-factor codes; set it up with `canvas-lms-mcp-remote totp-setup` |
| `CANVAS_MCP_TUNNEL` | | `ngrok` | `ngrok`, `cloudflared`, or `none` if you route the address yourself |
| `CANVAS_MCP_CLOUDFLARED_TOKEN` | | — | Tunnel token from the Cloudflare dashboard |
| `CANVAS_MCP_FAILOVER_SECONDS` | | `50` | How long the serving computer can be silent before another takes over |
| `CANVAS_ALLOW_WRITES` | | `true` | `false` (or `0`, `no`, `off`) = nothing in Canvas can change. A value it can't read stops the server |
| `CANVAS_PROFILE` | | `full` | Which tools to turn on, by name or number: see [Tool profiles](#tool-profiles). A value it can't read stops the server |
| `CANVAS_TOOLS` / `CANVAS_DISABLE_TOOLS` | | all / — | Only these tool groups or tools, or leave these out |
| `CANVAS_CACHE_TTL` | | `60` | Response cache time in seconds |
| `CANVAS_TIMEZONE` | | system | IANA time zone for dates, digests and quiet hours |
| `CANVAS_DOWNLOAD_DIR` | | `./canvas-downloads` | Where download tools save files. They can't save anywhere outside it |
| `CANVAS_CHANGE_LOG` | | `on` | `off` stops keeping the list of what the server changed in Canvas (`get_change_log`). It keeps IDs only, never what you wrote |
| `CANVAS_IP_FAMILY` | | both | `4` or `6` uses only that kind of address. Worth trying if new connections time out |
| `CANVAS_MCP_HOST` / `_PORT` | | `127.0.0.1` / `3939` | Bind address |
| `CANVAS_MCP_OAUTH_STORE_PATH` | | `./oauth-store.json` | Token store |
| `CANVAS_MCP_NGROK_PATH` | | found by itself | Full path to ngrok, if the server can't find it (it looks in the winget install on Windows, and on `PATH` and in the Homebrew, snap and usual install folders elsewhere) |
| `CANVAS_MCP_TRUST_PROXY` | | `loopback` | Which proxy's visitor address to trust; Docker uses `uniquelocal` |
| `CANVAS_MCP_TRANSPORT` | | `http` | `stdio` (or the `--stdio` flag) serves over stdin/stdout instead of HTTP. Used by directories that inspect servers. For everyday local use, see the [Local Edition](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local) |

Phone-alert settings are listed in [Phone alerts](#phone-alerts).

### Tool profiles

Fewer tools can help an AI app pick the right one. Set `CANVAS_PROFILE` in `.env` to a name or number, such as `CANVAS_PROFILE=study` or `CANVAS_PROFILE=3`, then run `canvas-lms-mcp-remote restart`. Or run `canvas-lms-mcp-remote profile study`: it checks the name, backs up `.env` and saves it.

<!-- profiles:start -->
| Number | Name | What it's for | Tools |
|:-:|---|---|:-:|
| 1 | `essentials` | The daily basics: what's due, your grades, announcements and reading an assignment. Nothing here changes Canvas. Best for small local models. | 24 |
| 2 | `core` | A bit of everything, including turning in work and sending messages. | 49 |
| 3 | `study` | Planning your week and studying: planner, calendar, study plans, course files and pages. | 38 |
| 4 | `grades` | Grades and feedback: scores, what-if, what you need on the final, rubrics and comments. | 31 |
| 5 | `readonly` | Everything that only looks. Nothing in Canvas can change. | 177 |
| 6 | `full` | Every tool. The default. | 242 |
<!-- profiles:end -->

- Not set means `full`: every tool, as before.
- `CANVAS_TOOLS` and `CANVAS_DISABLE_TOOLS` narrow any profile further. They never add a tool the profile leaves out.
- `essentials` and `readonly` never change anything in Canvas, even with `CANVAS_ALLOW_WRITES=true`. `CANVAS_ALLOW_WRITES=false` turns changes off in every profile.
- Use the same profile on every computer in a group, or the tools change when another computer takes over.
- Names other than `full` and `core` need version 1.5.0 or newer. An older version can't read them and won't start.

## Tools

| Group | Count | Highlights |
|---|:-:|---|
| Identity | 28 | `list_recent_history`, `check_token_expiry`, notification preferences, custom-data storage |
| Courses | 17 | `course_contacts` (teachers, TAs, office hours), permissions, nicknames |
| Assignments | 13 | `assignment_brief`, `list_missing_submissions`, `get_late_policy` |
| Submissions | 18 | `recent_feedback`, text, URL, file and annotation submission, comments, rubric assessments |
| Grades | 15 | `final_grade_scenarios`, `what_if_grade`, `compute_needed_score`, `grade_impact_ranking`, `calculate_gpa` |
| Quizzes | 12 | read-only: dates, attempts, reviews |
| Discussions | 21 | `get_full_topic_view`, replies, school-wide announcements, mark announcements read |
| Inbox | 14 | messaging, `find_recipients`, threads |
| Calendar | 11 | events, office-hours booking |
| Content | 37 | `next_module_items`, files, pages, modules, captions, ePortfolios, `read_course_file` for PDF, Word and PowerPoint, course export |
| Groups | 11 | group workspaces |
| Rubrics | 11 | peer reviews |
| Search | 3 | `smart_search` with keyword fallback |
| Planner | 12 | `daily_briefing`, planner notes, `mark_planner_item_done`, `study_plan`, `export_deadlines_ics`, calendar feed |
| Planning | 14 | `find_exams`, `get_week_ahead`, `semester_snapshot`, `study_priority_ranking`, `semester_wrap_up`, `export_all_courses` |
| Meta | 5 | `get_change_log`, `raw_canvas_request` for any endpoint not listed above |

### Prompts and attachments

The server also adds these to your AI app's menus. They don't count as tools.

- **Prompts**: *Daily briefing*, *Plan my week*, *Plan my study blocks*, *What did I miss?*, *Start this assignment*, *Prep me for an exam*, *How are my grades?*, *Am I on track to pass?*, *Catch me up on a course*, *Draft an email to my professor*, *Semester wrap-up*, *Quiz me*, *Check my draft*, *Weekly review* and *What does my feedback say?* Each one tells the assistant which tools to use, and course names autocomplete. A prompt only shows up when the [tool profile](#tool-profiles) has every tool it uses.
- **Attachments**: attach a course syllabus, or an assignment due in the next 14 days, to a chat the same way you'd attach a file.

Apps that support MCP prompts and resources, such as Claude Desktop, show them in the **+** menu.

## Phone alerts

Because the Remote Edition is always on, it can tell you when something happens. On by default once you set a channel:

- **New grades** (several at once arrive as one summary)
- **New announcements**
- **Work due within 24 hours** that you haven't submitted yet
- **A Canvas token that expires within 5 days**

Add any of these to `CANVAS_ALERTS` to turn them on too: `assignments` (new assignments, quizzes and discussions), `comments` (a teacher commented on your work), `inbox` (new messages), `grade_drop` (a course grade fell below `CANVAS_ALERTS_GRADE_BELOW`, default 70%) and `security` (sign-ins and lockouts on your server).

**Where they go.** Add any of these to `.env`, then restart the server:

| Channel | Settings |
|---|---|
| [ntfy](https://ntfy.sh) phone app | `CANVAS_ALERTS_NTFY_TOPIC`: a long, hard-to-guess topic name (it works like a password). `CANVAS_ALERTS_NTFY_SERVER` for your own server |
| Discord | `CANVAS_ALERTS_DISCORD_WEBHOOK`: a webhook from a channel's **Settings → Integrations → Webhooks** |
| Telegram | `CANVAS_ALERTS_TELEGRAM_TOKEN` (from @BotFather) and `CANVAS_ALERTS_TELEGRAM_CHAT_ID` |
| Slack | `CANVAS_ALERTS_SLACK_WEBHOOK`: an incoming webhook URL |
| Microsoft Teams | `CANVAS_ALERTS_TEAMS_WEBHOOK`: a Workflows incoming webhook URL |
| Pushover | `CANVAS_ALERTS_PUSHOVER_TOKEN` and `CANVAS_ALERTS_PUSHOVER_USER` |

**When they come.**

| Setting | Default | What it does |
|---|---|---|
| `CANVAS_ALERTS_DIGEST` | — | One summary a day at this time, e.g. `07:30`: what's due today and tomorrow, new grades, missing work and unread messages |
| `CANVAS_ALERTS_MODE` | `both` with a digest | `digest` sends only urgent alerts (due soon, token, security) in between digests; `instant` turns the digest off |
| `CANVAS_ALERTS_QUIET` | — | e.g. `22:00-07:00`: non-urgent alerts wait until the morning and arrive as one summary |
| `CANVAS_ALERTS_COURSES` / `_SKIP_COURSES` | all | Only (or never) these courses, by ID or part of the name |
| `CANVAS_ALERTS_DUE_HOURS` | `24` | How far ahead "due soon" alerts look |
| `CANVAS_ALERTS_INTERVAL_MINUTES` | `15` | How often to check (at least 5) |

Then run `canvas-lms-mcp-remote test-alert` from your settings folder to check it works.

Only the computer that is serving sends alerts, and it remembers what it already sent in your Canvas account's own storage, so you don't get repeats when another computer takes over. Alert text passes through the service you pick, so keep the topic, channel or chat private.

## Security

- **Confirmation gate:** tools that send, submit, post, upload or delete return a preview and a one-time token first. The token only works for that exact request, for 5 minutes, and is refused if the assignment or file changed. It can't prove you agreed, so keep your AI app's own "ask before running" setting on for these tools.
- **Prompt-injection fencing:** text other people wrote is wrapped in `<<<CANVAS_CONTENT>>>` markers and labelled as untrusted.
- **Your token only goes to Canvas:** every request is checked, so no tool can send it anywhere else.
- **The server's disk:** downloads only go in the download folder and never replace a file. Uploads refuse `.env` files, keys, sign-in files and this server's settings folder.
- **No quiz-taking:** quiz attempt endpoints are deliberately not included, and writes to them are refused for every tool, however the address is written.
- **Loopback only:** the server listens on `127.0.0.1`. The only way in from outside is the tunnel.
- **It won't start open:** with a public address it refuses to start without a real password, and it refuses the example values from `.env.example`.
- **OAuth 2.1:** login is limited to 10 attempts per 15 minutes per address, and five wrong passwords lock that address out for 15 minutes. Access tokens last 1 hour, and refresh tokens are replaced every time they're used. An old refresh token used again signs that sign-in out. Tokens meant for another server are refused. The password check takes the same time whatever you type.
- **Look-alike apps are flagged:** the login page shows where you go back to after connecting, and warns you when an app calls itself Claude or ChatGPT but would send your sign-in somewhere else.
- **Two-factor codes (optional):** `canvas-lms-mcp-remote totp-setup` adds a code from your authenticator app to the login and status pages. Each code works once.
- **You can see and end sign-ins:** the status page lists signed-in apps and recent sign-in attempts. Unused apps are signed out after 90 days, and `rotate-password` signs everyone out.
- **Separate coordination secret:** the endpoints the computers use to coordinate need a separate shared secret, compared in constant time. Too many wrong guesses lock that address out.
- **No secrets in logs:** tokens, passwords and webhook keys are removed from every log line. The public `/healthz` check says nothing about your account.
- **Download links expire:** files the server saves are shared through private links that work for one hour.

> **Never commit** `.env`, `oauth-store.json`, `login-history.json` or `supervisor.log`. They're already listed in `.gitignore`. See [SECURITY.md](SECURITY.md).

## Responsible use

This is a study and organization tool. It helps you see deadlines, understand your grades and plan your week. It never takes quizzes, and nothing is sent or submitted until you've seen a preview and confirmed it.

- Follow your school's academic integrity and acceptable-use policies. Some schools restrict personal API tokens or third-party tools.
- Want to be sure nothing in Canvas changes? Set `CANVAS_ALLOW_WRITES=false` for read-only mode. Downloads still work, into your download folder.

## Troubleshooting

Start with **`canvas-lms-mcp-remote doctor`** in your settings folder: it checks the settings, token, network, tunnel, server and startup service, and says how to fix what it finds.

| Symptom | Fix |
|---|---|
| `ERR_NGROK_121` | Your ngrok version is too old. Run `ngrok update` |
| `ERR_NGROK_334 … already online` | Another computer or a leftover `ngrok.exe` holds the domain. This is normal for a standby computer |
| `ERR_NGROK_3200` (endpoint offline) | No computer is serving. Check `canvas-lms-mcp-remote logs` |
| ngrok shows a "You are about to visit…" page at login | This is normal on the free plan. Click **Visit Site**, or use Cloudflare Tunnel, which has no such page |
| `startup check failed` | Check `CANVAS_BASE_URL` and your internet connection |
| "Your Canvas token was rejected" | Your token expired. Create a new one and put it in `.env` |
| Reading works but uploads or new connections time out | Run `doctor` on that computer: its Network section times DNS and tests every connection. The server works around a slow DNS lookup by itself, so if a connection still fails, look for a VPN, proxy or firewall |
| "File not found on the computer running this server" | The server reads files from its own disk, so the path must exist on the computer named in the error, not the one you're chatting from |
| Your AI app struggles with so many tools | Pick a smaller [tool profile](#tool-profiles): in your settings folder, run `canvas-lms-mcp-remote profile essentials` (or `1`), then `canvas-lms-mcp-remote restart`. Use the same profile on every computer in your group |
| New tools don't show up | Reconnect the connector or restart your AI app |
| `supervisor.log` keeps growing | Run `canvas-lms-mcp-remote install-service` again to switch to the rotating log |

More issues with several computers are covered in the [Multi-Device guide](MULTI_DEVICE.md#troubleshooting).

**Restart cleanly** with `canvas-lms-mcp-remote restart`. Running an older version that doesn't know it? In PowerShell:
```powershell
Stop-ScheduledTask -TaskName CanvasSupervisor -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'supervisor\.js|index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Start-ScheduledTask -TaskName CanvasSupervisor
```
On a Mac, in Terminal:
```bash
launchctl unload ~/Library/LaunchAgents/io.github.fireiscoolsolo.canvas-mcp-remote.plist
pkill -f 'supervisor\.js|index\.js|canvas-lms-mcp-remote'; pkill ngrok
launchctl load -w ~/Library/LaunchAgents/io.github.fireiscoolsolo.canvas-mcp-remote.plist
```

**Known limits:** a student token can't reach admin endpoints, gradebook history, course analytics or quiz statistics. `smart_search` is a Canvas beta feature and often returns 404. While the server is reached over the tunnel, apps get a preview before actions instead of a pop-up confirmation.

## License

[MIT](LICENSE). This project isn't affiliated with Instructure.
