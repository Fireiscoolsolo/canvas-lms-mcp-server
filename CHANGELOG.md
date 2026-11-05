# Changelog

All notable changes to `canvas-lms-mcp-remote`. The tools are shared with the Local Edition
([canvas-lms-mcp-local](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local)), so tool changes appear in both changelogs.

## 1.3.1

### Fixed
- **A slow DNS lookup no longer breaks new connections.** On some computers the system's lookup takes longer than the 10 seconds Node allows for a new connection, every time. If it hasn't answered within a second, the server now asks the DNS server directly too and uses the first answer.
- **A lost connection no longer fails a submission or upload.** When a connection never opened, nothing reached Canvas, so every request is now tried again, not only reads. Requests that may have reached Canvas are still never repeated, so nothing is submitted twice.
- **Uploads and downloads retry.** The upload slot request, the storage upload and file downloads now retry lost connections. The storage upload also has a time limit now.
- **Errors say what failed.** Upload errors name the step, the host and the error code, and the school-address hint only appears for the school's own address. Signed upload addresses are never shown.
- **Tool failures are logged**, with the time, tool, step, host and error code, so they can be traced afterwards. The token and signed addresses are left out.
- A missing file's error names the computer running the server. If a submission fails after its upload, the error says to check `get_my_submission` first.
- A standby computer retries a lost heartbeat once before counting it, and logs the error code.

### New
- `doctor` has a **Network** section: how long DNS takes, and whether a new secure connection opens to each of the school's addresses.
- `CANVAS_IP_FAMILY=4` (or `6`) uses only that kind of address.

## 1.3.0

### Status page and sign-ins
- **Status page** at `https://<your-domain>/status`, behind your password: whether the server is online and which computer is
  serving, the Canvas connection and when the token expires, signed-in apps, recent sign-ins, the computers in your group,
  phone-alert settings and recent problems. Nothing secret is shown.
- **Signed-in apps** are listed with a Sign out button (also `canvas-lms-mcp-remote sessions`). Apps that never finished signing in
  are removed after a week, and apps unused for 90 days are signed out.
- **Login protection:** five wrong passwords from one address lock it out for 15 minutes; every sign-in attempt is kept in a login
  history; the password check takes the same time whatever you type; the login page shows which app is asking; a return address the
  app didn't register is refused.
- **Optional two-factor codes** (`canvas-lms-mcp-remote totp-setup`) for the login and status pages.
- **`rotate-password`** makes a new password and signs every app out.

### Phone alerts
- New alert types (opt-in): new assignments, quizzes and discussions posted; teacher comments on your work; new inbox messages;
  a course grade dropping below a line you pick (`CANVAS_ALERTS_GRADE_BELOW`); sign-ins and lockouts on your server (`security`).
- A **daily digest** at a time you choose (`CANVAS_ALERTS_DIGEST`), on its own or alongside instant alerts (`CANVAS_ALERTS_MODE`).
- **Quiet hours** (`CANVAS_ALERTS_QUIET`): non-urgent alerts wait, then arrive as one summary.
- **Per-course filters** (`CANVAS_ALERTS_COURSES`, `CANVAS_ALERTS_SKIP_COURSES`).
- **More channels:** Telegram, Slack, Microsoft Teams and Pushover, alongside ntfy and Discord.

### Running it
- **Cloudflare Tunnel** as an alternative to ngrok (`CANVAS_MCP_TUNNEL=cloudflared`), or no tunnel at all (`none`) if you route the
  address yourself.
- **`install-service`** sets up auto-start on Windows (scheduled task), Linux (systemd user service) or macOS (launch agent);
  `uninstall-service` removes it.
- **New commands:** `status`, `logs [-f]`, `doctor`, `stop`, `restart`, `uninstall`, `sessions`, `cluster`, `takeover`, `totp-setup`, `totp-off`.
- **Log rotation:** with `--log-file supervisor.log` (used by `install-service` and `run-supervisor.cmd`) the supervisor writes its
  own log and rotates it at 5 MB, keeping three old files. Secrets are removed from every line.
- **Docker:** a `Dockerfile` and `docker-compose.yml` (with ngrok, or Cloudflare Tunnel) for a home server or NAS.

### Several computers
- Standby computers send a heartbeat, so the status page and `canvas-lms-mcp-remote cluster` list every computer and which one is serving.
- `canvas-lms-mcp-remote takeover` makes the computer you're on the one that serves.
- `CANVAS_MCP_FAILOVER_SECONDS` sets how quickly a standby takes over (default 50 seconds).

### Downloads
- Files the server saves (course files, deadline calendars, archives) come back as private download links that work for one hour,
  so a phone can open them.

### Tools (shared with the Local Edition)
- 237 tools, up from 211: planner notes and checking items off, a daily briefing, study plans, an assignment brief, final-grade
  scenarios, course contacts, an end-of-term wrap-up, calendar feed and .ics export, school-wide announcements, notification
  preferences, ePortfolios and annotation submissions.
- Clean text with headings, links, lists and tables; friendly dates; long lists one page at a time; plain-English errors; a
  heads-up in the token's last week; safer retries; structured results; progress updates; six new prompts; `CANVAS_TOOLS` and
  `CANVAS_DISABLE_TOOLS`. See the Local Edition's changelog for the full list.

### Other changes
- `/healthz` no longer shows your school's address (it is public). The details moved to the status page.
- `.env.example` lists every new setting.

## 1.2.3
- README: connecting the ChatGPT desktop app.

## 1.2.2
- README links the Local Edition website.

## 1.2.1
- Points Windows users to the free setup app; website link in the MCP Registry entry.

## 1.2.0
- Phone alerts, reading course files, a GPA calculator, prompts and attachable Canvas items.

## 1.0.0 to 1.1.2
- First releases: the 211 student tools over Streamable HTTP with an OAuth login, an ngrok tunnel and multi-computer failover.
