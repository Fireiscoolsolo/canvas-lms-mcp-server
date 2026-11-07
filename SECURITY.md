# Security

## Keep these private
| File | Contains |
|---|---|
| `.env` | Your Canvas token, connector password and cluster secret |
| `oauth-store.json` | Login tokens for every connected device |
| `.env.backup-*` | Older copies of `.env`, made by `rotate-password` and `totp-setup` |
| `login-history.json` | When and from which addresses people tried to sign in |
| `supervisor.log` | Your hostname, school site and tunnel address |

All of them are listed in `.gitignore`. On Linux and macOS the server writes them so only your user can read them. On Windows, keep the settings folder inside your user profile, where other accounts can't read it. If one is ever exposed:
1. **Canvas token:** delete it in *Canvas → Settings → Approved Integrations* and create a new one.
2. **Password or cluster secret:** change it in `.env` and restart.
3. **oauth-store.json:** delete it and restart. Every device will have to log in again.

## What the server refuses
- It won't start with a public address and an empty or example password, or with an example or short cluster secret. The log and `canvas-lms-mcp-remote doctor` say what to change.
- It only sends your Canvas token to the address in `CANVAS_BASE_URL`. Every request is checked first, and files stored on other hosts are fetched without it.
- It doesn't save downloads outside `CANVAS_DOWNLOAD_DIR`, or upload `.env` files, keys, sign-in files or its own settings folder.

## What confirmation does and doesn't do
Text in Canvas is written by other people and reaches your AI app, so a post or file could try to talk the AI into doing something. The checks above apply either way, and quiz-taking endpoints can't be reached.

Apps connected over the network can't be asked a question mid-request, so the AI gets a preview and a one-time token. That token stops a stale or changed request, but the AI receives it, so it can't prove you said yes. Your app's own "ask before running" setting is what keeps you in control, so leave it on for tools that send, submit, upload or delete.

## Reporting a vulnerability
Please open a private [security advisory](../../security/advisories/new) rather than a public issue.
