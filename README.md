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

## Deploy (Unraid or any Docker host)

```sh
POSTGRES_PASSWORD=<something-long> docker compose up -d
```

Open `http://<host>:3850` — **the first account registered becomes the
instance admin.** After creating your users, set `ALLOW_REGISTRATION=false`
in the compose environment and `docker compose up -d` again to close signup
(admins can still create users from /admin).

Unraid notes:
- Use the *Compose Manager* plugin (or `docker compose` via terminal) with this
  folder. Host port `3850` is arbitrary — change the mapping if taken.
- Volumes: `pgdata` (database) and `uploads` (attachments). Back up both —
  `docker exec trboard-db pg_dump -U trboard trboard > trboard.sql` plus a copy
  of the uploads volume.
- Behind NPM/Cloudflare: proxy to port 3850, enable websockets. Cookies are
  `Secure` automatically when served over https.

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
