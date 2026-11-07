# Changelog

All notable changes to `canvas-lms-mcp-remote`. The tools are shared with the Local Edition
([canvas-lms-mcp-local](https://github.com/Fireiscoolsolo/canvas-lms-mcp-local)), so tool changes appear in both changelogs.

## Unreleased

### Security
- **The token is never sent unencrypted.** A school address written with `http://` is now used with `https://`, and the log says so. Only a Canvas running on the same computer keeps `http://`.
- **Your Canvas token only goes to Canvas.** Every request now passes one check, so no tool can send the token to another address, whether that address came from the model, a next-page link, a file record or an upload. Files stored on another host are fetched without it. `download_submission_attachment` only takes addresses on your Canvas. If your school uses a second address for Canvas, use that one in `CANVAS_BASE_URL`.
- **The quiz block can't be spelled around.** It now runs on the final address, for every tool and every write method.
- **Requests stay inside the Canvas API.** A path can't climb out of `/api/v1`, and endpoints that hand out sign-in links or tokens, or add a contact method to your account, are refused.
- **An ID can only be an ID.** A value with `/`, `\`, `?`, `#` or `%` in it is refused, so it can't turn a harmless tool into a request to a different endpoint. Canvas's own forms such as `self` and `sis_course_id:BIO-101` still work.
- **Settings that restrict the server can't fail open.** `CANVAS_ALLOW_WRITES` now understands `false`, `0`, `no` and `off` in any case, and `CANVAS_PROFILE` ignores stray spaces. A value it can't read now means the safe choice, and every Canvas tool says what to fix instead of carrying on with everything switched on.
- A name in `CANVAS_TOOLS` or `CANVAS_DISABLE_TOOLS` that matches nothing is now reported in the log and in `get_server_config`.
- **Downloads stay in your download folder.** `dest_dir` can only be `CANVAS_DOWNLOAD_DIR` or a folder inside it, even through links. To save somewhere else, change `CANVAS_DOWNLOAD_DIR`.
- **A download never replaces a file.** A different file with the same name is saved as `name (1).pdf`, and the same file isn't saved twice.
- **Private files are never uploaded.** Uploads refuse `.env` files, keys, sign-in files, this server's settings folder, and the folders that browsers and AI apps keep their data in. Schoolwork still uploads from any other folder.
- **Confirmation can't be skipped.** Apps connected to Remote get a preview with a one-time token, tied to that tool and those exact details, for 5 minutes. A submission, delete or upload is refused if the assignment, item or file changed after the preview. The token stops stale or swapped requests. It doesn't prove a person said yes, so your AI app's own approval step still matters.
- **More actions ask first:** `upload_to_my_files`, `upload_submission_file`, `upload_comment_attachment`, `delete_planner_note`, `delete_bookmark`, `update_planner_note`, `update_calendar_event`, `rate_entry`, `create_content_export`, `export_course_archive`, and every write through `raw_canvas_request`.
- **Fences around other people's text are harder to break.** A fake end marker is now caught in any case, with invisible characters, in full-width or look-alike brackets, or with two brackets instead of three. Text that only starts like a fence is fenced like anything else. Every tool that passes Canvas text straight through now fences the longer fields (descriptions, bodies, messages, captions, rubric and outcome text, quiz items, planner notes) wherever they appear, and text sent to Canvas is refused if it carries any spelling of a marker.
- **The server won't start open to the internet.** With a public address or a `CANVAS_MCP_HOST` other computers can reach, it now stops with a message if the password is empty or still the example from `.env.example`, if the cluster secret is the example or under 16 characters, if there's no public address for sign-in to use, or if a restrictive setting can't be read. The supervisor makes the same check, and `doctor` reports it. A password under 12 characters only warns for now. `--stdio` is not affected.
- **Guessing the cluster secret gets locked out** after 20 wrong tries from one address in 15 minutes. Correct requests never count, so heartbeats are safe.
- **An app's name can't run as code on the status page.** Anyone could register an app, so a crafted name could run in your browser when you clicked Sign out. A name with an apostrophe also skipped the "are you sure" prompt. Both are fixed.
- **Password pages are harder to abuse.** The login and status pages now refuse to be framed, aren't cached, send no referrer, and the browser won't run any script they didn't ship with.
- **The login page says where your sign-in goes.** Anyone who knows your address could register an app called "Claude" that sends the sign-in to their own site, and your real login page would have asked for your password. The page now names the site you go back to, warns you when an app calls itself Claude or ChatGPT but goes somewhere else, and flags sites it doesn't know.
- **Sign-ins are stricter.** An app has to register a return address, and a code only works with the address it was sent to. Only the `canvas` scope is granted. A token issued for another server's address is refused. At most 100 apps can be registered: old ones that never finished signing in make room, and signed-in apps are never removed.
- **A stolen refresh token stops working.** Using a refresh token after it was replaced now signs that sign-in out, so a copied token and the real app can't both keep going. The app just asks for the password again.
- **Two-factor codes work once**, across the login and status pages. With two-factor on, a wrong password and a wrong code get the same message, so the page never says the password was right.
- Sign-in codes and wrong-password counts no longer pile up in memory, and sign-in error pages aren't cached.
- **Lock on the status page really signs you out.** It used to clear the cookie in your own browser only, so a copied cookie kept working for up to 12 hours. Sessions are now random IDs that Lock ends everywhere, and a restart ends them all, so you may need to enter the password again after updating.
- **Wrong passwords on the status page count.** They now go through the same lockout as the login page, appear in recent sign-ins, and a lockout sends the security alert. With security alerts on, signing in to the status page sends a sign-in alert too.

- **Secret files are private.** On Linux and macOS, `.env`, its backups, `oauth-store.json` and `login-history.json` are now written so only your user can read them. `.env.backup-*` and temp files are now in `.gitignore`.

### Fixed
- **Two computers no longer both serve on Cloudflare Tunnel.** Cloudflare runs every connector it is given, so a standby that lost internet for a minute and took over kept serving alongside the first computer, and apps failed at random. A serving computer now asks the public address who answers it, and when another computer does, the one that took over more recently steps back. A step-down request can now name the computer it is for, so it can't land on the wrong one.
- **One slow tool no longer holds up every device.** Requests to `/mcp` were handled one at a time, so a five-minute export kept your phone waiting five minutes for anything at all. Each request now gets its own server, sharing one Canvas connection, so other requests answer straight away.
- **A tool the app stops waiting for stops asking Canvas.** When your AI app cancels a call or the connection drops, a tool that only reads stops before its next Canvas request instead of running to the end. Anything that changes Canvas always finishes, so a submission never stops half way. A read that runs for 20 minutes is stopped and says so.
- **An interrupted handoff no longer signs everyone out.** A standby computer saves its copy of the sign-ins whole or not at all, and only if the copy looks right. Before, a crash or a bad answer part way could leave a broken file. The login history is saved the same way.
- **Remote works on Node 18 again.** Every request to `/mcp` failed with "crypto is not defined", because the MCP SDK's HTTP transport uses a global that Node 18 doesn't have by default.
- **Apps on the same computer can sign in on any port.** An app that came back on a different port than it registered got past the first sign-in step and was then refused at the password, although the standard allows it.

### Releases
- **A publish from GitHub checks itself first.** Every file that names the version has to agree, the changelog needs a section for it, and the shared tools have to match the other edition. The actions it uses are pinned to exact versions, and the MCP Registry publisher is a fixed release checked against its published checksum. Every test run now also fails if the shared tools differ between the two editions.

### If your server stops starting after this update
Read the last lines of `supervisor.log`, or run `canvas-lms-mcp-remote doctor`. It names the setting to change in `.env`. Docker setups need `CANVAS_MCP_PUBLIC_URL` and your own `CANVAS_MCP_PASSWORD`.

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
