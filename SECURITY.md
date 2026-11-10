# Security

## Supported versions
Security fixes go into the newest release only, so keep every computer in your group up to date, then run `canvas-lms-mcp-remote doctor` on each one. On Windows, the [Canvas MCP Installer Assistant](https://fireiscoolsolo.github.io/canvas-lms-mcp-local/app/) updates it for you.

| Version | Gets security fixes |
|---|---|
| The newest release | Yes |
| Anything older | No. Update first |

It needs Node.js 18 or newer (22 or newer to read PDFs). Every change is tested on Node 18, 20, 22 and 24, on Windows, macOS and Linux.

## Threat model

### What it protects
- **Your Canvas token.** It can do anything you can do in Canvas, so keeping it safe matters most.
- **Your server password and sign-ins**: who can use your Canvas through this server.
- **Your Canvas account**, from changes you didn't ask for: submissions, posts, messages and deletes.
- **Files on the server's computer**: where downloads go, and what can be uploaded.

### Who it defends against
| Who | What they could try | What stops them |
|---|---|---|
| **Anyone who can write in your Canvas**: teachers, classmates and other users | Hide instructions in a post, page, message, file or name, hoping your AI follows them | Limits that hold whatever the AI is told. The token only goes to your Canvas. Quiz-taking, sign-in and token endpoints are refused. An ID can't change which endpoint a tool calls. Downloads stay in your download folder. Private files can't be uploaded. Changes need a preview and a one-time token. Their text is also fenced and labelled as untrusted, which helps the AI but is advice, not a wall |
| **Someone on the internet who knows your address** | Guess your password, trick you into typing it for a look-alike app, or try the endpoints the computers use to coordinate | The server won't start with an empty or example password. Five wrong passwords lock an address out for 15 minutes, on the login and status pages alike. Two-factor codes are optional, and each works once. The login page names where your sign-in goes and warns about look-alike apps. Wrong guesses at the cluster secret are locked out too |
| **An app you connected, or someone who copied its token** | Keep using your Canvas through the server | Access tokens last an hour. A copied refresh token used after the real app has moved on signs that sign-in out. Tokens issued for another server are refused. You can sign any app out on the status page, and `rotate-password` signs every app out |
| **Mistakes** | A typo that leaves writes on when you meant them off, or a crash part way through saving the sign-ins | A setting the server can't read stops it from starting, and says what to fix. Sign-ins and secrets are saved whole or not at all |

### What it can't protect against
- **Your AI app and the company that runs it.** They see everything the tools return, and can call any tool that is switched on. A confirmation token shows the request didn't change after the preview, not that you said yes. Keep your app's "ask before running" setting on for tools that send, submit, upload or delete. To switch tools off, use `CANVAS_DISABLE_TOOLS`, or `CANVAS_ALLOW_WRITES=false` for read-only.
- **Your tunnel provider.** ngrok and Cloudflare end the HTTPS connection on their side before they forward it, so they could see requests and replies. Use one you trust.
- **Anyone with your password**, and your two-factor code if it's on.
- **The other computers in your group.** They share the cluster secret, so each one can read the sign-ins and sign apps out. Only add computers you control.
- **Anyone or anything using the server's computer account.** Malware, or another person signed in as you, can read `.env` and `oauth-store.json`.
- **Canvas, your school and Instructure's file storage.** They already hold your data.
- **A flood of traffic.** The rate limits slow guessing down, but the server isn't built to stay up under a deliberate flood.

## Keep these private
| File | Contains |
|---|---|
| `.env` | Your Canvas token, connector password and cluster secret |
| `oauth-store.json` | Login tokens for every connected device |
| `.env.backup-*` | Older copies of `.env`, made by `rotate-password` and `totp-setup` |
| `login-history.json` | When and from which addresses people tried to sign in |
| `supervisor.log` | Your hostname, school site and tunnel address |
| `changes.jsonl`, `changes.old.jsonl` | Which courses and items the server changed in Canvas, and when (`get_change_log`). IDs only, never what you wrote. `CANVAS_CHANGE_LOG=off` turns it off |

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
