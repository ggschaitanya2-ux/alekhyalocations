# CLAUDE.md — Alekhya Locations

Shared location master (Site › Block › Floor › Flat › Room / Common area / Plot / Villa) for all Lakshmi Alekhya apps. Admin + PM edit; every other app reads and stores `location_id`.

## Stack
- Node 22 + Express (`server.js`, single file), `pg`, `jsonwebtoken`, `bcryptjs`
- PostgreSQL 16 — **same database as Alekhya Gate** (`alekhya_gate`). Tables: `locations`, `location_types`, `location_audit`, `location_meta`; view `location_paths`
- Frontend: `public/index.html`, single file, vanilla JS, no build. Keep it a single file.
- Runs on 127.0.0.1:3200 behind Caddy at `loc.150-241-247-25.sslip.io`
- Server folder: `/opt/alekhya/alekhya-locations`; systemd unit `alekhya-locations`

## Auth
- Logins come from the Gate's `users` table (bcrypt hash column `USERS_PASSWORD_COL`, default `password_hash`).
- `JWT_SECRET` must equal the Gate's, so Gate tokens are accepted here.
- `EDIT_ROLES` (default `admin,pm`) may change locations; `ADMIN_ROLES` (default `admin`) manage types + hard delete. Everyone else read-only. `API_KEYS` = read-only keys for other servers.

## Rules
- Migrations are plain SQL in `sql/`, run in filename order on every start — they must stay idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `CREATE OR REPLACE VIEW`). Add new files (`002_….sql`); don't edit applied ones in breaking ways.
- Never change a location's `id`. Prefer deactivate over delete. Hard delete only for empty, unreferenced nodes.
- Every write: inside `tx()`, write `audit()`, call `bump()`.
- Don't rename a `location_types.code` that's in use; change the label.
- Never commit `.env` or secrets. Ask before anything destructive on the server.

## Deploy
- First time: `bash deploy/setup.sh`
- Update: `bash deploy/update.sh` (git pull → npm ci → migrate → restart → health check)
- Logs: `journalctl -u alekhya-locations -n 100`

## Troubleshooting
- 401 on login → check `USERS_TABLE` / `USERS_PASSWORD_COL` match the Gate schema (`\d users` in psql).
- Gate token rejected → `JWT_SECRET` differs from the Gate `.env`.
- Other app's browser call blocked → add its origin to `CORS_ORIGINS`, restart.
- Caddy cert → `sudo journalctl -u caddy -n 50`.
