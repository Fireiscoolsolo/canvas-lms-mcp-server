# 🔁 Multi-Device Setup Guide

This guide covers two different things that both count as "multiple devices":

| | What it means | Effort |
|---|---|---|
| **[Part 1: Use it from many devices](#part-1-use-it-from-many-devices)** | Your phone, laptop, desktop and web app all reach the **same** server | ~2 minutes |
| **[Part 2: Host it on several computers](#part-2-host-it-on-several-computers-automatic-failover)** | Two or more computers each run the server. One serves at a time, and another takes over automatically when it turns off or sleeps | ~10 minutes per extra computer |

Finish the main [README setup](README.md#-quick-start) on your **first** computer before starting.

---

## Part 1: Use it from many devices

The server has one public address (`https://<your-domain>/mcp`), so any device or AI app that supports remote MCP servers can use it.

### Web, desktop and mobile apps
1. In your AI app's settings, find **Connectors** (sometimes called *Integrations* or *MCP servers*) and choose **Add custom connector**.
2. Name it **Canvas** and enter `https://<your-domain>/mcp`.
3. Click **Connect**. A login page opens. Enter your `CANVAS_MCP_PASSWORD`.

If your app syncs connectors to your account, it also shows up in that app's desktop and mobile versions. If an app ever asks you to connect again, enter the same password. You only do this once per app, because tokens refresh automatically after that.

### Command-line and editor clients
Add an **HTTP** (Streamable HTTP) MCP server named `canvas` with the URL `https://<your-domain>/mcp`. When the client asks you to authenticate, a browser window opens. Enter your password there.

> 💡 Seeing ngrok's **"You are about to visit…"** page during login is normal on ngrok's free plan. Click **Visit Site**. It only appears in real browsers, never for your AI app's own requests.

---

## Part 2: Host it on several computers (automatic failover)

### What you get
- **Turn on any computer, or all of them, and it just works.** Exactly one is **active**: it runs the server and holds the ngrok tunnel. The others wait in **standby**.
- **If the active computer sleeps, shuts down or goes offline,** a standby computer notices within about a minute and takes over the tunnel automatically.
- **Nobody gets logged out.** Standby computers keep a fresh copy of the login tokens (`oauth-store.json`), so devices stay connected after a takeover.
- **No cloud sync needed.** The computers coordinate entirely through your public ngrok address, using a shared secret.

```
            ┌─────────────── your-domain.ngrok-free.dev ───────────────┐
            │                                                           │
   ┌────────▼─────────┐   GET /internal/whoami (every 25 s)   ┌─────────┴────────┐
   │  Computer A      │ ◄──────────────────────────────────── │  Computer B      │
   │  ACTIVE          │   GET /internal/handoff (every ~100 s)│  STANDBY         │
   │  server + ngrok  │ ────────── oauth-store.json ────────► │  supervisor only │
   └──────────────────┘                                       └──────────────────┘
          If A stops answering twice in a row, B starts its server and claims the tunnel.
```

### Rules every computer must follow

| Setting | Same on every computer? | Notes |
|---|:-:|---|
| `CANVAS_MCP_PUBLIC_URL` | ✅ **must match** | The one shared ngrok domain |
| `CANVAS_MCP_CLUSTER_SECRET` | ✅ **must match** | If it doesn't match, the computers reject each other (`403`) |
| `CANVAS_MCP_PASSWORD` | ✅ **must match** | Otherwise new logins fail whenever the mismatched computer is active |
| ngrok **account** (authtoken) | ✅ **must match** | A static domain belongs to one ngrok account |
| `CANVAS_BASE_URL` | ✅ same | Your school |
| `CANVAS_API_TOKEN` | either | Recommended: a **separate token per computer**, so you can revoke one without breaking the others |

---

### Step 1: Install on the new computer

Install [Node.js 18+](https://nodejs.org), then run:

```bash
git clone https://github.com/Fireiscoolsolo/canvas-lms-mcp-server.git
cd canvas-lms-mcp-server
npm install
```

### Step 2: Bring over your settings safely

Create `.env` in the repo folder with the **same** values as your first computer for the four shared settings:

```ini
CANVAS_API_TOKEN=token_for_this_computer
CANVAS_BASE_URL=https://yourschool.instructure.com
CANVAS_MCP_PUBLIC_URL=https://your-domain.ngrok-free.dev
CANVAS_MCP_PASSWORD=same_password_as_computer_A
CANVAS_MCP_CLUSTER_SECRET=same_secret_as_computer_A
```

> 🔒 **Move secrets carefully.** Type them in, or use a password manager or a USB drive. **Don't** email them, put them in cloud storage, or commit them. If you made a temporary copy to move the file, delete it afterwards.

Don't copy `oauth-store.json`. The new computer downloads a fresh copy from the active computer automatically.

### Step 3: Install ngrok with the same account

```powershell
winget install --id Ngrok.Ngrok -e
ngrok update
ngrok version
ngrok config add-authtoken <the SAME ngrok authtoken as computer A>
```

> ⚠️ **Run `ngrok update`.** The winget package is often too old for ngrok's free plan and fails with `ERR_NGROK_121` (agent version too old). `ngrok version` should report **3.20 or newer**.
>
> If `ngrok.exe` isn't at `%LOCALAPPDATA%\Microsoft\WinGet\Links\ngrok.exe`, add `CANVAS_MCP_NGROK_PATH=C:\full\path\to\ngrok.exe` to `.env`.

### Step 4: Start it automatically at logon

Run this in PowerShell **from the repo folder**:

```powershell
$dir      = (Get-Location).Path
$action   = New-ScheduledTaskAction -Execute "$dir\run-supervisor.cmd" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName CanvasSupervisor -Action $action -Trigger $trigger -Settings $settings -Description "Canvas MCP supervisor (server + ngrok tunnel)" -Force
Start-ScheduledTask -TaskName CanvasSupervisor
```

No administrator rights are needed. The task runs as you.

> `run-supervisor.cmd` assumes Node is at `C:\Program Files\nodejs\node.exe`. If yours is somewhere else, edit that file. On Linux, see [the systemd user service below](#linux-run-it-as-a-systemd-user-service). On macOS, run `node supervisor.js` with launchd or pm2 instead.

### Linux: run it as a systemd user service

On Linux, use a systemd **user** service instead of the scheduled task. No root needed here either.

The supervisor looks for ngrok at the Windows path by default, so point it at your ngrok in `.env`:

```bash
echo "CANVAS_MCP_NGROK_PATH=$(command -v ngrok)" >> .env
```

Create `~/.config/systemd/user/canvas-mcp.service`. Use your real repo path, and the output of `command -v node` for the node path (user services don't get your shell's `PATH`, so nvm installs won't be found otherwise):

```ini
[Unit]
Description=Canvas MCP supervisor (server + ngrok tunnel)
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=/home/you/canvas-lms-mcp-server
ExecStart=/usr/bin/node supervisor.js
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
```

Then enable and start it, and let it keep running after you log out (or before you log in after a reboot):

```bash
systemctl --user daemon-reload
systemctl --user enable --now canvas-mcp
loginctl enable-linger "$USER"
```

The supervisor writes its log to stdout, so on Linux it goes to the journal instead of `supervisor.log`. Follow it with:

```bash
journalctl --user -u canvas-mcp -f
```

Use that wherever this guide says to read `supervisor.log`. For a clean restart, `systemctl --user restart canvas-mcp` is enough, since systemd stops the child processes too. After a `git pull`, run `npm install` and then that restart.

### Step 5: Check that it worked

Wait about 15 seconds, then read the log:

```powershell
Get-Content .\supervisor.log -Tail 20
```

You should see **one** of these, and both are correct:

| Log says | Meaning |
|---|---|
| `becoming active` → `active and serving at https://…` | No other computer was serving, so this one took over |
| `… is already active and healthy — syncing data and starting in standby` | Another computer is active. This one copied the login tokens and is standing by |

Then confirm the public address answers:

```powershell
Invoke-RestMethod https://<your-domain>/healthz -Headers @{ 'ngrok-skip-browser-warning' = '1' }
```

Expected: `ok: True`, `tools: 209`, `auth_enabled: True`.

### Step 6: Test failover in both directions

**Stop the active computer completely** (run on the computer that's currently active):

```powershell
Stop-ScheduledTask -TaskName CanvasSupervisor -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'supervisor\.js|index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
```

Within about 1 to 1.5 minutes, the other computer's `supervisor.log` should show:

```
whoami check failed (1/2) …
whoami check failed (2/2) …
active instance appears to be gone — taking over
becoming active
active and serving at https://…
```

Ask your assistant something about Canvas. It should still work, without logging in again.

**Bring the first computer back:**

```powershell
Start-ScheduledTask -TaskName CanvasSupervisor
```

It should report that the other computer is already active and settle into **standby** without interrupting anything. Then repeat the test the other way round.

### Adding a third (or fourth) computer
Repeat Steps 1–6 on that computer. There's no limit: one computer is active and all the others stand by.

---

## How failover behaves

| Situation | What happens |
|---|---|
| A computer boots while another is healthy | It copies the login tokens and goes to **standby**. It never takes over from a healthy computer |
| The active computer sleeps, shuts down or loses internet | Standby computers check every **25 s**. After **2** failed checks, plus a random 0–4 s delay so two standby computers don't both take over, one takes over |
| The sleeping computer wakes up | Its ngrok can't reconnect because the domain is taken (`ERR_NGROK_334`), so it **steps back to standby on its own** |
| Two computers try to become active at once | ngrok lets only one hold the domain. The other detects this and returns to standby |
| The server crashes on the active computer | The supervisor restarts it after 3 s |
| The supervisor itself crashes | The scheduled task restarts it within a minute (up to 999 times) |

> 💤 **Tip:** someone has to be awake to serve requests. If all your computers are laptops that sleep, the connector is offline until one wakes up. Setting one plugged-in computer to never sleep gives you an always-on primary.

---

## Restarting cleanly

`Stop-ScheduledTask` doesn't always stop the child processes, and a leftover `node.exe` or `ngrok.exe` can keep holding the port or the tunnel. Use this instead:

```powershell
Stop-ScheduledTask -TaskName CanvasSupervisor -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'supervisor\.js|index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName CanvasSupervisor
```

## Updating the code on every computer

```powershell
git pull
npm install
```
Then do a clean restart (above). You can update one computer at a time, because the others cover for it.

## Changing secrets

| Change | What to do |
|---|---|
| **Password** | Update `CANVAS_MCP_PASSWORD` in `.env` on **every** computer, then restart each one. Devices that are already connected stay logged in |
| **Cluster secret** | Update it on **every** computer at the same time, then restart each one |
| **Canvas token** | Update `CANVAS_API_TOKEN` on that computer only, then restart it |
| **ngrok authtoken** | Run `ngrok config add-authtoken <new>` on **every** computer |
| **Log everyone out** | Stop all computers, delete `oauth-store.json` on each, then start them again |

Generate strong random values with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ERR_NGROK_334 … already online` in the log | Another computer holds the tunnel. **This is normal** for a standby computer. If no computer should be active, a leftover `ngrok.exe` is holding the domain, so do a [clean restart](#restarting-cleanly) |
| `ERR_NGROK_121` (agent version too old) | Run `ngrok update` |
| `ERR_NGROK_3200` (endpoint offline) | No computer holds the tunnel right now. Wait about 90 s for a standby computer to take over, then check each computer's `supervisor.log` |
| `whoami check failed … 403` | `CANVAS_MCP_CLUSTER_SECRET` doesn't match. It must be identical on every computer |
| Devices asked to log in again after a takeover | The token copy failed. Look for `could not sync session data` in the log of the computer that took over. Check its internet connection and the cluster secret |
| `ngrok failed to start … (checked path: …)` | ngrok isn't installed at that path. Set `CANVAS_MCP_NGROK_PATH` in `.env` |
| Every computer stays in standby and nobody serves | Check that each computer's ngrok uses the **same account**, and that nothing else is using port 3939 |
| Port 3939 already in use | A leftover `index.js` is running. Do a [clean restart](#restarting-cleanly), or set `CANVAS_MCP_PORT` to another port on that computer |
| New devices can't log in, but only sometimes | The computers have different passwords. Make `CANVAS_MCP_PASSWORD` identical everywhere |
