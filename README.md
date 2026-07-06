# TR Board

Self-hosted Trello — TR Studios. Multi-user with team-gated visibility, live
sync, and Trello's paid features free: custom fields, Calendar/Timeline/Table/
Dashboard views, unmetered Butler-style automation, admin controls, uncapped
attachments, global search, "My Work", card dependencies, public intake forms,
board export/copy, link sharing, card mirroring, and inline card previews.

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
POSTGRES_PASSWORD=<something-long> docker compose up -d
```

`docker-compose.yml` pulls the pre-built image and starts Postgres alongside it.
Open `http://<host>:3850` — **the first account registered becomes the instance
admin.** After creating your users, set `ALLOW_REGISTRATION=false` in the compose
environment and `docker compose up -d` again to close signup (admins can still
create users from /admin). To build from source instead of pulling, use
`docker compose -f docker-compose.build.yml up -d --build`.

## Deploy on Unraid

**Easiest — Compose Manager plugin (brings up the app + Postgres together):**

1. Install the **Compose Manager** plugin from Community Applications.
2. Add a new stack called `tr-board`, and paste the contents of
   [`docker-compose.yml`](docker-compose.yml).
3. Set a strong `POSTGRES_PASSWORD` (edit the compose or add a `.env`), then
   **Compose Up**. Both containers appear on the Docker tab.
4. Open `http://<tower-ip>:3850` and register the first account (= admin).

**Alternative — Community Applications template (app container only):** use
[`unraid/tr-board.xml`](unraid/tr-board.xml) if you'd rather run the app as a
native Unraid container and point it at your **own** PostgreSQL 16 container via
`DATABASE_URL`. (The app image does not include a database.)

Notes:
- Host port `3850` is arbitrary — change the mapping if it's taken.
- Data lives in two volumes: **Postgres data** and **uploads** (attachments).
  Map the uploads path to `/mnt/user/appdata/tr-board/uploads` so it sits on the
  array. Back up both — `docker exec trboard-db pg_dump -U trboard trboard >
  trboard.sql` plus a copy of the uploads directory.
- Behind NGINX Proxy Manager / Cloudflare: proxy to port 3850 and **enable
  WebSockets** (live sync needs them). Cookies become `Secure` automatically
  once served over https.

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
docker run -d --name trboard-pg-dev -e POSTGRES_USER=trboard \
  -e POSTGRES_PASSWORD=trboard-dev -e POSTGRES_DB=trboard \
  -p 127.0.0.1:5433:5432 -v trboard-pg-dev:/var/lib/postgresql/data postgres:16-alpine
npm install
npm run dev:server   # Fastify + sockets on :8841 (migrates on boot)
npm run dev:web      # Vite on :8840, proxies /api + /socket.io → 8841
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
                      Board, Admin
```
