# Security

## Keep these private
| File | Contains |
|---|---|
| `.env` | Your Canvas token, connector password and cluster secret |
| `oauth-store.json` | Login tokens for every connected device |
| `supervisor.log` | Your hostname, school site and tunnel address |

All three are listed in `.gitignore`. If one is ever exposed:
1. **Canvas token:** delete it in *Canvas → Settings → Approved Integrations* and create a new one.
2. **Password or cluster secret:** change it in `.env` and restart.
3. **oauth-store.json:** delete it and restart. Every device will have to log in again.

## Reporting a vulnerability
Please open a private [security advisory](../../security/advisories/new) rather than a public issue.
