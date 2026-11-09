# TR Board

Self-hosted Trello — TR Studios. Multi-user with team-gated visibility, live
sync, and Trello's paid features free: custom fields, Calendar/Timeline/Table/
Dashboard views, unmetered Butler-style automation, admin controls, uncapped
attachments, global search, "My Work", card dependencies, public intake forms,
board export/copy, link sharing, card mirroring, inline card previews,
recurring cards, iCal calendar feeds, TOTP two-factor, OIDC single sign-on, and
whole-instance backup and restore.

Scope/design brief: `SCOPE.md`.

## Stack

React 19 + TS + Vite + Tailwind v4 + dnd-kit + zustand + TanStack Query ·
Fastify 5 + Socket.IO + Zod · PostgreSQL 16 + Drizzle (SQL migrations applied
automatically on boot) · single Docker image, compose with Postgres.

The image is published to GHCR — **no build step, no registry login**:
`ghcr.io/tehrobot-assistant/tr-board:latest` (built and pushed automatically
by GitHub Actions on every push).

## Deploy on any Docker host

```sh
cp .env.example .env    # set POSTGRES_PASSWORD (required: compose refuses to start without it)
docker compose up -d
```

`docker-compose.yml` pulls the pre-built image and starts Postgres alongside it.
Data goes in bind mounts under `TRBOARD_DATA` (default
`/mnt/user/appdata/trboard`, so set e.g. `TRBOARD_DATA=./data` on a non-Unraid
host). Open `http://<host>:3850`. **The first account registered becomes the
instance admin, and registration then closes:** further accounts are created by
an admin in /admin and invited to workspaces. Set `ALLOW_REGISTRATION=true`
only if you want open self-sign-up. To build from source instead of pulling,
use `docker compose -f docker-compose.build.yml up -d --build`.

The app itself refuses to start if `DATABASE_URL` is unset or has no password.

## Deploy on Unraid

**Easiest — Compose Manager plugin (brings up the app + Postgres together):**

1. Install the **Compose Manager** plugin from Community Applications.
2. Add a new stack called `tr-board`, and paste the contents of
   [`docker-compose.yml`](docker-compose.yml).
3. In the stack's env file set a strong `POSTGRES_PASSWORD` (see
   [`.env.example`](.env.example)), then **Compose Up**. Both containers appear
   on the Docker tab with the TR Board icon and a WebUI link (from the
   `net.unraid.docker.*` labels).
4. Open `http://<tower-ip>:3850` and register the first account (= admin).

**Alternative — Community Applications template (app container only):** use
[`unraid/tr-board.xml`](unraid/tr-board.xml) if you'd rather run the app as a
native Unraid container and point it at your **own** PostgreSQL 16 container via
`DATABASE_URL` (required, masked, must include a password).

Notes:
- Host port `3850` is arbitrary — change the mapping if it's taken.
- Data lives in two bind mounts: `/mnt/user/appdata/trboard/postgres` and
  `/mnt/user/appdata/trboard/uploads` (attachments). Being under appdata, both
  survive a `docker.img` rebuild and are covered by the Appdata Backup plugin.
  For a consistent copy of everything in one file use **Admin > Download
  backup** or scheduled backups (see [Backup and restore](#backup-and-restore)).
- The app container runs as **root** on purpose (like our other Unraid apps):
  Docker creates missing bind-mount dirs as `root:root`, which a non-root user
  can't write to.
- **Upgrading an install that used the old named volumes** (`pgdata`,
  `uploads`): copy the data across before switching, e.g.
  `docker run --rm -v <stack>_pgdata:/from -v /mnt/user/appdata/trboard/postgres:/to alpine cp -a /from/. /to/`
  (same for `uploads`). Keep `POSTGRES_PASSWORD` equal to the password the
  existing database was created with: Postgres ignores it on an existing data
  dir. If that was the old default `trboard`, change it with
  `ALTER USER trboard PASSWORD '...'` and update `.env`.
- Behind NGINX Proxy Manager / Cloudflare: proxy to port 3850 and **enable
  WebSockets** (live sync needs them). Then set two env vars (compose `.env`
  or the Unraid template):
  - `TRUST_PROXY=loopback,linklocal,uniquelocal` lets proxies on private
    addresses (Docker networks, NPM on the same box, cloudflared) supply
    `X-Forwarded-For`/`-Proto`. Without it every request appears to come from
    the proxy, so the login and public-form rate limits are one shared bucket
    and one abuser locks everyone out. A hop count (`1`) or explicit IPs/CIDRs
    also work; `true` trusts any hop, so use it only if port 3850 is not
    reachable except through the proxy (a client could otherwise forge its IP).
  - `COOKIE_SECURE=true` makes the session cookie `Secure`. With it unset, the
    cookie is `Secure` only when the request arrived over https, which behind a
    proxy needs `TRUST_PROXY` plus an `X-Forwarded-Proto: https` header. With a
    Cloudflare tunnel into NPM over plain http that header says `http`, so set
    `COOKIE_SECURE=true` explicitly. Don't set it for plain-http LAN access:
    browsers drop Secure cookies on http, and sign-in would stop working.

## Backup and restore

**Admin > Backup & restore** (instance admins only):

- **Download backup** gives one `.tar.gz` with every table (as NDJSON) and every
  attachment, plus a `manifest.json` holding the app version, the applied
  database migrations and a sha256 for every file. It is taken from one
  database snapshot, so it is consistent. It contains password hashes, 2FA
  secrets and calendar-feed tokens: keep it private. Login sessions are not
  included.
- **Restore** (upload a file, or pick a scheduled backup) first unpacks and
  checks the archive without touching anything: checksums, no unexpected
  files or paths, and the **same database migrations as this instance**. It
  then shows what will be replaced (users, boards, cards... now vs after) and
  only runs when you type `RESTORE`. The database is replaced in one
  transaction, then the uploads folder is swapped. Everyone is signed out and
  signs in with the accounts from the backup.
- **Version rule:** a backup restores only onto the same set of migrations. To
  restore an older backup, run the TR Board image version that made it (tag),
  restore, then upgrade; migrations run on boot. A newer backup needs a newer
  image.
- **Fresh install:** start the stack, register the first account (it becomes
  admin), then restore. That account is replaced by the backup's users.

**Scheduled backups** (optional, env):

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | empty (off) | Folder inside the container. Compose and the Unraid template mount one at `/backups`, so set `BACKUP_DIR=/backups`. |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between backups. Counted from the newest file in the folder, so container restarts don't add extra backups or reset the clock. |
| `BACKUP_KEEP` | `7` | Newest N files kept; older `trboard-backup-*.tar.gz` files are deleted. |
| `BACKUP_MAX_RESTORE_GB` | `50` | Largest archive the restore upload accepts. |

Files are named `trboard-backup-YYYYMMDD-HHMMSS.tar.gz` (UTC), written under a
hidden `.partial` name and renamed when complete, with mode `0600`.

**Unraid layout:** the app's data sits in `/mnt/user/appdata/trboard/`
(`postgres/`, `uploads/`). Compose mounts `${TRBOARD_BACKUPS}` (default
`/mnt/user/appdata/trboard/backups`) at `/backups`; the template has a
**Backups** path for the same thing. Point it at an **array share** such as
`/mnt/user/backups/trboard` rather than appdata if you can: appdata usually
lives on the cache pool, and a pool failure would then take the database and
its backups together. Temporary files during backup/restore go in
`uploads/.trboard-tmp/` (same disk as the uploads, never `docker.img`) and are
cleared on boot. The Appdata Backup plugin can keep backing up
`/mnt/user/appdata/trboard` as before; the TR Board backup is the one you can
restore with a click.

## Calendar feeds (iCal)

**Account settings > Calendar feeds > Create feed links** gives subscribable
`.ics` URLs: **My cards** (cards I'm a member of and checklist items assigned
to me, across every board I can see) and one per board. Subscribe in Google
Calendar ("From URL"), Apple Calendar or Outlook. Due dates become events; a
card with a start and a due date becomes one event spanning them; completed
cards show a ✓.

- The URL holds a 256-bit secret per user. **Regenerate links** replaces it,
  and the old URLs return 404 immediately. **Turn off** removes it.
- Permissions are checked on every fetch, through the same code as the rest of
  the app: lose access to a board and its events vanish on the calendar's next
  refresh, and that board's feed returns 404.
- Limits: read-only, one-way. Events older than 180 days are left out, and a
  feed holds at most 2,000 events. How often the calendar refreshes is up to
  the calendar app (Google: every several hours).

## Recurring cards

Card > **↻ Repeat**: every N days, weeks (on chosen weekdays), months or years.
The card needs a due date. When its due date is **ticked complete**, a copy is
made with the next due date (the start date moves by the same amount),
checklist items unticked, and labels, members and custom fields carried over;
attachments and comments stay with the finished card. The copy goes to the
card's list, or to a list you pick. The rule moves to the new card, so the ↻
indicator on the card front always marks the upcoming one.

The next date steps from the previous **due date**, in the time zone of the
browser that set the rule (so "Monday 9am" stays Monday 9am across daylight
saving). A card completed late skips straight to the next future date rather
than creating overdue copies. Nothing runs on a timer, so restarts can't fire
it twice.

## Two-factor authentication (TOTP)

**Account settings > Two-factor authentication > Set up**: scan the QR code
with any authenticator app, enter a code, and save the 10 recovery codes
(single use, stored hashed). Sign-in then becomes two steps: password (or SSO),
then a 6-digit code or a recovery code. Codes are single use, and wrong codes
are rate-limited per IP and per account (`MFA_MAX_FAILS_PER_IP`, default 30,
`MFA_MAX_FAILS_PER_ACCOUNT`, default 10, per 15 minutes); each pending sign-in
allows 5 tries and lasts 5 minutes. Turning 2FA off needs the password.

Instance admins can **Reset 2FA** for a user (lost phone) on the Admin page,
and can tick **Require two-factor for every account**: accounts without it can
then only sign in to set it up (no boards, sockets or calendar feeds until
they do). The admin turning it on must have 2FA first.

## Single sign-on (OIDC)

Set these (compose `.env` or the Unraid template, advanced view); SSO is on
when the first three are set, and the login page gets a "Sign in with SSO"
button.

| Variable | Meaning |
|---|---|
| `OIDC_ISSUER` | Issuer URL of the provider (discovery is read from `<issuer>/.well-known/openid-configuration`). |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | The client registered at the provider. |
| `OIDC_REDIRECT_URI` | `https://<your board>/api/auth/oidc/callback`, registered at the provider exactly. |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` (default) or `client_secret_post`. |
| `OIDC_SCOPES` | Default `openid email profile`. |
| `OIDC_BUTTON_LABEL` | Default `Sign in with SSO`. |
| `OIDC_AUTO_PROVISION` | Default `false`. See below. |
| `OIDC_ALLOW_INSECURE_HTTP` | Default `false`. Allows an `http://` issuer (LAN-only IdP). |

**Who gets in:** an account already linked to that SSO identity; otherwise an
existing account with the same email, **only if the provider marks the email
verified** (`email_verified: true`). That account is then linked to the
identity's subject, so later logins don't depend on the email. An account
already linked to a different identity is refused. Nobody else gets in unless
`OIDC_AUTO_PROVISION=true` **and** registration is open
(`ALLOW_REGISTRATION=true`): with registration invite-only, SSO only signs in
accounts an admin created. Accounts made by SSO have no password. A user's own
TOTP still applies after SSO. Login uses authorization code + PKCE via
[`openid-client`](https://github.com/panva/openid-client).

**Authentik:** Applications > Providers > Create > OAuth2/OpenID Provider.
Client type *Confidential*, redirect URI as above (strict), signing key set.
Create an Application for it (slug e.g. `tr-board`). Then:
`OIDC_ISSUER=https://auth.example.com/application/o/tr-board/` (with the
trailing slash; it must match the issuer Authentik reports). Authentik's
default `email` scope mapping may report `email_verified: false` depending on
the version; if SSO says the email isn't verified, edit that scope mapping (or
add your own) to return `"email_verified": True` for users whose email you
trust. **[unverified against a live Authentik]**

**Authelia** (`identity_providers.oidc.clients` in `configuration.yml`):

```yaml
- client_id: tr-board
  client_name: TR Board
  client_secret: '$pbkdf2-sha512$...'   # hash of the secret you put in OIDC_CLIENT_SECRET
  public: false
  authorization_policy: two_factor
  redirect_uris: [ 'https://board.example.com/api/auth/oidc/callback' ]
  scopes: [ openid, email, profile ]
  token_endpoint_auth_method: client_secret_basic
```

`OIDC_ISSUER=https://auth.example.com`. Recent Authelia releases put email
only in the userinfo response, not the ID token; TR Board reads userinfo when
the ID token has no email. **[unverified against a live Authelia]**

**Google:** Cloud Console > APIs & Services > Credentials > Create OAuth
client ID > *Web application*, add the redirect URI. Then
`OIDC_ISSUER=https://accounts.google.com`. Google marks Gmail and verified
Workspace addresses as verified. With auto-provisioning off (the default),
only Google accounts whose email matches an existing TR Board account get in.

## Permissions model (the point of the thing)

```
User ──< TeamMember >── Team (workspace-scoped)
User ──< WorkspaceMember >── Workspace ──< Board
Board.visibility ∈ private | team | workspace
Board roles: admin | member | observer (read-only) | guest (single-board)
```

Every REST endpoint **and** every socket room join re-checks membership —
UI hiding is never the security boundary. Workspace governance (who can create
boards / invite / change visibility) lives in workspace Settings.

## Development

```sh
export DATABASE_URL=postgres://trboard:trboard-dev@127.0.0.1:5433/trboard  # required, no default
docker run -d --name trboard-pg-dev -e POSTGRES_USER=trboard \
  -e POSTGRES_PASSWORD=trboard-dev -e POSTGRES_DB=trboard \
  -p 127.0.0.1:5433:5432 -v trboard-pg-dev:/var/lib/postgresql/data postgres:16-alpine
npm install
npm run dev:server   # Fastify + sockets on :8841 (migrates on boot)
npm run dev:web      # Vite on :8840, proxies /api + /socket.io → 8841
```

Tests (Docker required; each run starts and removes its own throwaway Postgres):

```sh
npm test -w server   # unit (TOTP/recurrence/iCal/tar) + integration against a real server:
                     # review regressions, feeds, recurrence, backup/restore, 2FA, OIDC (mock IdP)
npm test -w web      # client: board store live sync (reconnect, event replay, rank ties), recurrence helpers
```

Schema changes: edit `server/src/db/schema.ts`, then
`cd server && npx drizzle-kit generate` (writes SQL into `server/drizzle/`,
applied automatically on next boot).

## Licence

MIT — see [LICENSE](LICENSE).

## Layout

```
server/src/
  db/schema.ts        every table (SCOPE §6)
  lib/perms.ts        boardAccess()/visibleBoardIds() — THE security boundary
  lib/auth.ts         argon2id + hashed session tokens
  lib/rank.ts         lexical ranks — drag-reorder is a 1-row UPDATE
  lib/totp.ts, mfa.ts TOTP + the two-step login ticket; routes/twofactor.ts, oidc.ts
  lib/backup.ts, tar.ts  backup/restore archive + scheduler; routes/backup.ts
  lib/recurrence*.ts  recurring cards; lib/ical.ts + routes/feeds.ts calendar feeds
  routes/             auth, workspaces+teams, boards, lists, cards,
                      cardDetail (labels/checklists/comments/attachments),
                      phase1 (fields/automation/activity/notifications), admin
  automation/engine.ts  Butler-lite: triggers, conditions, actions + due ticker
  sockets/index.ts    membership-gated board rooms
web/src/
  stores/board.ts     live board state: socket events + optimistic mutations
  components/         KanbanView (dnd-kit), TableView, CalendarView,
                      TimelineView, CardModal, BoardMenu (rule builder), Chrome
  pages/              Login, Home, Workspace (members/teams/governance),
                      Board, Admin (users, security, backup), Account (2FA, feeds)
```
