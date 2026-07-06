# TR Board — self-hosted Trello (scope & build brief)

**One line:** a close copy of Trello, self-hosted on Unraid, that ships Trello's
paywalled features for free — multi-user with team-based visibility, live sync,
custom fields, extra views, automation, and real admin/permissions.

**Name:** **TR Board** (confirmed) — a member of the TR Studios app collection;
**bundle/package it at the end** to add alongside the other apps.

**Status:** scope FINAL (2026-07-06), ready to build. Fable 5 builds it **in one
continuous pass** — the phases in §7 are the internal build *order* (skeleton
first, features hang off it), not separate hand-backs. Lives at
`projects/media-tools/board/`.

> Replaces the "dashboard" part of the old `media-tools` project (a static
> status board reading `projects.csv` / `portfolio.json`). The other tools in
> `media-tools/` (radarr, sonarr, stocks, concerts, trip-planner) stay put for
> now; some become **integration widgets** later (see Phase 2).

---

## 1. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| **Users** | Multi-user. Mostly Graham, but named accounts + **teams that split what each user sees** is core. | Permissions/visibility is a first-class requirement, not an add-on. |
| **Hosting** | **Self-hosted Docker on Unraid** (app + Postgres via Compose). | Free, data stays home, real-time-friendly, matches how Planka/Wekan run. |
| **Real-time** | **Live sync** — move a card, everyone on that board sees it instantly. | The real Trello feel; expected of a modern board. |
| **v1 paid features** | **All four:** custom fields, extra views (Calendar/Timeline/Table), automation (Butler), admin & permissions. | Graham selected all; they define "Trello, not a list." |

---

## 2. What Trello actually paywalls (so "free the paid stuff" is concrete)

| Feature | Trello tier | We ship it |
|---|---|---|
| Unlimited boards | Standard+ | ✅ free (self-hosted) |
| Custom fields | Standard+ | ✅ v1 |
| Card mirroring | Standard+ | ✅ v1/v2 |
| Advanced checklists (assignee + due per item) | Premium+ | ✅ v1 |
| Calendar / Timeline / Table / Dashboard views | Premium+ | ✅ v1 (Dashboard v2) |
| Unlimited automation (Butler) | metered on Free/Standard | ✅ v1, unmetered |
| Admin controls, board-creation governance | Premium+ | ✅ v1 |
| Workspace templates | Premium+ | ✅ v2 |
| Large/unlimited attachments (Trello caps 10 MB free / 250 MB paid) | paid | ✅ free — local disk, no cap |
| SSO / OIDC | Enterprise | ✅ optional (OIDC-ready, v2) |
| AI (Atlassian Intelligence) | Premium+ | ⏸ deferred / optional |

**Net:** everything Trello charges for except AI lands in v1–v2 at zero cost.

---

## 3. What the open-source clones teach us (borrow, don't reinvent)

- **Planka** — closest Trello look/feel; clean card editor (checklists, labels,
  attachments, assignees, due dates); OIDC auth; **Postgres-backed**. → our
  visual + data-model reference.
- **Wekan** — best Trello *familiarity*; real-time via Meteor DDP; **swimlanes**,
  custom fields, and a **Trello import** tool. → swimlanes + import are worth stealing.
- **Focalboard** (Mattermost) — killer **custom fields** (text/number/date/
  select/multi/person/checkbox/url/email/phone) and **multi-view** (board/table/
  gallery/calendar). → our custom-fields + views bar.
- **Kanboard** — deepest workflow/automation, lightweight PHP. → automation ideas.

Design target: **Planka's polish + Focalboard's fields/views + Wekan's import/swimlanes.**

---

## 4. Recommended stack (committed unless Graham objects)

- **Frontend:** React + TypeScript + Vite + Tailwind. Drag-and-drop via
  **dnd-kit** (best-in-class for kanban). Server state via TanStack Query.
- **Backend:** Node 22 + TypeScript + **Fastify**. Validation with Zod.
- **Real-time:** **Socket.IO**, one room per board. Handshake auth gates room
  joins by board membership — this is where "split what each user sees" is
  *enforced*, not just hidden in the UI.
- **DB:** **PostgreSQL 16** + **Drizzle ORM** (SQL-first, matches our habit;
  Prisma is the fallback if Fable prefers its DX). *SQLite/better-sqlite3 is the
  lighter alt — single-file backup is a homelab win — but Postgres is the right
  default for concurrent multi-user + real-time.*
- **Auth:** session cookies (email + password, argon2id), HttpOnly/SameSite.
  **OIDC-ready** so it can later sit behind Authentik/Authelia.
- **Files:** local Docker volume (unlimited attachments — a real win over Trello).
- **Deploy:** `docker-compose.yml` (app + postgres). Single instance v1 (no Redis;
  add Redis only if we ever run multiple app replicas for socket fan-out).

Rationale: React owns the kanban DnD ecosystem; Fastify+Socket.IO+Postgres is the
boring-and-correct real-time CRUD stack; all TypeScript end-to-end so Fable works
in one language.

---

## 5. Permissions & visibility model (the "key" requirement)

```
User ──< TeamMember >── Team
User ──< WorkspaceMember >── Workspace ──< Board
Board.visibility ∈ { private | team | workspace | link }
BoardMember.role ∈ { admin | member | observer(read-only) | guest(this board only) }
```

- A **Board** belongs to a Workspace and has a visibility level; a Team can be
  granted access so "this team sees these boards, that team doesn't."
- **Every** REST endpoint *and* every Socket room join checks membership — UI
  hiding is never the security boundary.
- Governance (Trello Premium): who can create boards / invite / change visibility
  is a workspace-admin setting.

---

## 6. Data model (first-cut tables)

`users`, `sessions`, `teams`, `team_members`, `workspaces`, `workspace_members`,
`boards`, `board_members`, `lists`, `cards`, `card_members`, `labels`,
`card_labels`, `checklists`, `checklist_items` (assignee + due), `comments`,
`attachments`, `custom_field_defs`, `custom_field_values`, `automation_rules`,
`activity_log`, `notifications`.

Ordering (lists within board, cards within list) via fractional/lexical rank keys
so drag-reorder is a single-row update, not a full renumber.

---

## 7. Feature scope, phased

### Phase 0 — Core Trello (must exist before "paid" features mean anything)
Auth + accounts · workspaces/teams · boards, lists, cards · **drag-drop** reorder
& move · labels · card members/assignees · checklists (advanced: per-item assignee
+ due) · comments · attachments (local, uncapped) · due dates · **live sync** ·
roles & board visibility · activity log (basic) · dark/light (carry the current
dashboard's theme).

### Phase 1 — The paid four (v1 headline)
1. **Custom fields** — per-board defs (text/number/date/checkbox/dropdown single+
   multi/member/url); show-on-front toggle; drive Table columns + Calendar/Timeline dates.
2. **Extra views** — Calendar (by due date), **Timeline/Gantt** (start→due), Table
   (spreadsheet w/ inline edit, custom fields as columns). Same cards, different lens.
3. **Automation (Butler-lite)** — per-board rules: trigger + conditions + actions.
   Triggers: card created / moved to list / label changed / due approaching /
   checklist completed / field changed. Actions: move, set/clear due, add/remove
   label, assign, set field, add checklist, comment, notify. Runs server-side on
   events; logged.
4. **Admin & permissions** — the model in §5, board-creation governance, private/
   team/workspace/link visibility, observer/guest roles.

### Phase 2 — Parity polish & our extras
Trello **JSON import** · workspace **templates** · card **mirroring** · saved
searches/filters · **swimlanes** (Wekan) · email notifications + digest · Dashboard
(charts) view · public read-only **link-shared** boards · 2FA · OIDC SSO ·
board export/backup · **integration widgets** (fold old media-tools in: Radarr/
Sonarr/stocks/concerts as cards or a board view) · mobile PWA.

### Deferred / maybe-never
AI features · Map view · native mobile apps.

---

## 8. Decisions (all resolved 2026-07-06)
- **DB = PostgreSQL.** ✅ confirmed (not SQLite).
- **Auth = local accounts (email+password).** OIDC stays a Phase 2 hook.
- **No seed data — start fresh.** ✅ Do NOT import the old `projects.csv` /
  `portfolio.json`; new empty install.
- **Name = TR Board.** ✅ Part of the TR Studios app collection; package at the end.

---

## 9. Handoff to Fable
**One continuous build**, worked in this order (order = dependency, not milestones):
Phase 0 → 1 → 2. Start with Docker Compose + Postgres schema + auth + board/list/
card CRUD + dnd-kit + Socket.IO sync (Phase 0 is the skeleton everything hangs on),
then Phase 1 paid features, then Phase 2. Ends as a self-contained,
`docker compose up`-able app ready to bundle into the TR Studios collection.
