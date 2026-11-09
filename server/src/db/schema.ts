/**
 * TR Board — full schema (SCOPE.md §6).
 *
 * Phase 0 + Phase 1 tables land together so the core never needs a mid-build
 * migration. Ordering of lists/cards uses lexical rank strings (see lib/rank.ts)
 * so a drag-reorder is a single-row UPDATE.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { RecurrenceRule } from "../lib/recurrenceRule.js";

/* ------------------------------------------------------------------ enums */

export const workspaceRole = pgEnum("workspace_role", ["admin", "member"]);
export const boardRole = pgEnum("board_role", [
  "admin",
  "member",
  "observer", // read-only
  "guest", // this board only, not a workspace member
]);
export const boardVisibility = pgEnum("board_visibility", [
  "private", // board members only
  "team", // board members + granted teams
  "workspace", // every workspace member
  "link", // anyone with the link (read-only), v2 — modelled now
]);
export const fieldType = pgEnum("field_type", [
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "multiselect",
  "member",
  "url",
]);

/* ------------------------------------------------------------- users/auth */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  avatarColor: text("avatar_color").notNull().default("#0079bf"),
  /** instance admin — can manage users + all workspaces */
  isAdmin: boolean("is_admin").notNull().default(false),
  theme: text("theme").notNull().default("system"), // system | light | dark
  /**
   * TOTP two-factor (lib/totp.ts). `totpSecret` is base32 and stored as-is:
   * the server has to compute codes from it, so hashing is impossible, and
   * anyone who can read this column can already read every board anyway.
   * 2FA is on iff totpEnabledAt is set. `totpPendingSecret` holds a secret
   * shown during enrolment until the first code proves the app has it.
   * `totpLastStep` is the 30 s step of the last accepted code, so one code
   * can't be replayed inside its validity window.
   */
  totpSecret: text("totp_secret"),
  totpPendingSecret: text("totp_pending_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  /** OIDC link: (issuer, subject) of the SSO identity bound to this account */
  oidcIssuer: text("oidc_issuer"),
  oidcSubject: text("oidc_subject"),
  /**
   * Calendar feed secret (routes/feeds.ts), 256-bit hex, in the feed URLs.
   * Stored in plain text on purpose so Account settings can show the URL again
   * for copying; a hash would mean "copy it now or regenerate". Whoever can
   * read this column can already read every card, so hashing would protect
   * nothing. Regenerating replaces it, which revokes the old URLs at once.
   */
  feedToken: text("feed_token").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_oidc_identity_idx").on(t.oidcIssuer, t.oidcSubject)]);

/**
 * TOTP recovery codes: single use, stored as sha256. The codes are 80 random
 * bits each, so a fast hash is enough (no dictionary to attack); argon2 would
 * only make each recovery attempt cost 19 MiB.
 */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

/**
 * Instance-wide settings an instance admin changes at runtime (env vars cover
 * the rest). Exactly one row, id = 1, created by migration 0004.
 */
export const instanceSettings = pgTable("instance_settings", {
  id: integer("id").primaryKey().default(1),
  /** every account must have TOTP on; accounts without it can only enrol */
  require2fa: boolean("require_2fa").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  /** random 256-bit token, stored hashed (sha256 hex) */
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------------------------------------------------- teams + spaces */

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** governance (Trello Premium): who may create boards / invite / set visibility */
  settings: jsonb("settings")
    .$type<{
      boardCreation?: "admins" | "members";
      inviting?: "admins" | "members";
      visibilityChanges?: "admins" | "members";
    }>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/** Teams are workspace-scoped groups used to gate board visibility. */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#61bd4f"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("teams_ws_idx").on(t.workspaceId)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

/* ------------------------------------------------------------------ boards */

export const boards = pgTable(
  "boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** background: a colour token or css gradient */
    background: text("background").notNull().default("navy"),
    visibility: boardVisibility("visibility").notNull().default("workspace"),
    /** set → anyone with /share/<token> gets a read-only snapshot */
    shareToken: text("share_token").unique(),
    archived: boolean("archived").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("boards_ws_idx").on(t.workspaceId)],
);

export const boardMembers = pgTable(
  "board_members",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: boardRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] })],
);

/**
 * Starred boards float to the top of the workspace home. Its own table (review
 * M7): stars used to be a `starred` flag on board_members, so starring a board
 * you could read via workspace/team visibility inserted an `observer`
 * membership, and that row kept granting read access after the board went
 * private. A star grants nothing; perms.ts never reads this table.
 */
export const boardStars = pgTable(
  "board_stars",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] }), index("board_stars_user_idx").on(t.userId)],
);

/** team-visibility grants: which teams can see a `visibility=team` board */
export const boardTeams = pgTable(
  "board_teams",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.teamId] })],
);

/* ------------------------------------------------------------ lists + cards */

export const lists = pgTable(
  "lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rank: text("rank").notNull(),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lists_board_idx").on(t.boardId)],
);

export const cards = pgTable(
  "cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    rank: text("rank").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    dueComplete: boolean("due_complete").notNull().default(false),
    /** cover: colour token, or attachment id rendered as image cover */
    coverColor: text("cover_color"),
    coverAttachmentId: uuid("cover_attachment_id"),
    /**
     * mirror card: renders the source card's face, opens the source. FK with
     * cascade (L7): deleting the source (directly, or via its list/board)
     * deletes its mirrors, matching what DELETE /api/cards/:id already did.
     */
    mirrorOfCardId: uuid("mirror_of_card_id").references((): AnyPgColumn => cards.id, { onDelete: "cascade" }),
    /**
     * Recurring card rule (lib/recurrence.ts), null = doesn't repeat. When the
     * card's due date is marked complete, the next copy is created and the
     * rule moves to it (so this column also works as the "already spawned"
     * claim: see spawnNextOccurrence).
     */
    recurrence: jsonb("recurrence").$type<RecurrenceRule>(),
    archived: boolean("archived").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cards_board_idx").on(t.boardId),
    index("cards_list_idx").on(t.listId),
    // propagateMirror looks mirrors up by source on every title/label change
    index("cards_mirror_of_idx").on(t.mirrorOfCardId),
  ],
);

export const cardMembers = pgTable(
  "card_members",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] })],
);

/* ------------------------------------------------------------------ labels */

export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    color: text("color").notNull(),
  },
  (t) => [index("labels_board_idx").on(t.boardId)],
);

export const cardLabels = pgTable(
  "card_labels",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.labelId] })],
);

/* -------------------------------------------------- checklists (advanced) */

export const checklists = pgTable(
  "checklists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rank: text("rank").notNull(),
  },
  (t) => [index("checklists_card_idx").on(t.cardId)],
);

export const checklistItems = pgTable(
  "checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checklistId: uuid("checklist_id")
      .notNull()
      .references(() => checklists.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    /** Trello Premium "advanced checklists": per-item assignee + due */
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    rank: text("rank").notNull(),
  },
  (t) => [index("checklist_items_cl_idx").on(t.checklistId)],
);

/* ------------------------------------------------- comments + attachments */

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [index("comments_card_idx").on(t.cardId)],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    uploaderId: uuid("uploader_id").references(() => users.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    /** path relative to the uploads volume, e.g. "<cardId>/<uuid>.<ext>" */
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attachments_card_idx").on(t.cardId)],
);

/* ------------------------------------------------- Phase 1: custom fields */

export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: fieldType("type").notNull(),
    /** select/multiselect options: [{id, label, color}] */
    options: jsonb("options")
      .$type<Array<{ id: string; label: string; color: string }>>()
      .notNull()
      .default([]),
    showOnFront: boolean("show_on_front").notNull().default(false),
    rank: text("rank").notNull(),
  },
  (t) => [index("cfd_board_idx").on(t.boardId)],
);

export const customFieldValues = pgTable(
  "custom_field_values",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFieldDefs.id, { onDelete: "cascade" }),
    /** shape depends on field type: string | number | boolean | string[] (option/member ids) */
    value: jsonb("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.fieldId] })],
);

/* --------------------------------------------------- Phase 1: automation */

export const automationRules = pgTable(
  "automation_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** { type: "card_created" | "card_moved" | "label_added" | ... , ...params } */
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    conditions: jsonb("conditions").$type<Array<Record<string, unknown>>>().notNull().default([]),
    actions: jsonb("actions").$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("automation_board_idx").on(t.boardId)],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    cardId: uuid("card_id").references(() => cards.id, { onDelete: "set null" }),
    ok: boolean("ok").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("automation_runs_rule_idx").on(t.ruleId)],
);

/**
 * due_approaching dedupe (review M10). Was an in-memory Set, so every restart
 * re-fired every card inside its window. One row per (rule, card) holding the
 * due date it fired for: moving the due date makes it eligible again, a
 * restart does not.
 */
export const automationDueFired = pgTable(
  "automation_due_fired",
  {
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.cardId] })],
);

/* ------------------------------------------------------- dependencies */

/** Monday-style dependencies: `card` blocks `blocksCard` (same board only) */
export const cardLinks = pgTable(
  "card_links",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    blocksCardId: uuid("blocks_card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.blocksCardId] })],
);

/* ------------------------------------------------------------- forms */

/** Monday WorkForms: public form → each submission becomes a card */
export const forms = pgTable(
  "forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    /** [{id,label,type:text|textarea|email|number|date|select,required,options?}] */
    fields: jsonb("fields")
      .$type<Array<{ id: string; label: string; type: string; required: boolean; options?: string[] }>>()
      .notNull()
      .default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("forms_board_idx").on(t.boardId)],
);

/* -------------------------------------------------- activity + notifications */

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    cardId: uuid("card_id").references(() => cards.id, { onDelete: "cascade" }),
    /** null actor = automation */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("activity_board_idx").on(t.boardId, t.createdAt),
    index("activity_card_idx").on(t.cardId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.read)],
);
