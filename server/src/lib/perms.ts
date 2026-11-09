/**
 * Permission resolution — SCOPE.md §5. This is the security boundary: every
 * REST endpoint and every socket room join resolves access here. UI hiding is
 * never trusted.
 *
 * Effective board access, in precedence order:
 *   1. instance admin            → admin
 *   2. board_members row         → its role (admin/member/guest write, observer read)
 *   3. workspace admin           → admin on every board in the workspace except
 *                                  `private` boards they're not a member of
 *                                  (Trello-true: private means private)
 *   4. visibility=workspace      → workspace members: read (join to write)
 *   5. visibility=team           → members of granted teams: read
 *   6. otherwise                 → no access
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export type BoardRole = "admin" | "member" | "observer" | "guest";

export type BoardAccess = {
  board: typeof schema.boards.$inferSelect;
  role: BoardRole | null; // explicit membership role, if any
  canRead: boolean;
  canWrite: boolean; // create/edit lists+cards etc.
  canAdmin: boolean; // board settings, members, visibility, fields, automation
  workspaceRole: "admin" | "member" | null;
};

export async function workspaceRoleOf(
  userId: string,
  workspaceId: string,
): Promise<"admin" | "member" | null> {
  const rows = await db
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function boardAccess(
  userId: string,
  boardId: string,
  /**
   * ignoreMembership: resolve access as if the user had no board_members row.
   * Used when pruning implicit memberships (lib/revoke.ts) to ask "would they
   * still see this board without the row?".
   */
  opts: { isAdmin?: boolean; ignoreMembership?: boolean } = {},
): Promise<BoardAccess | null> {
  const boardRows = await db
    .select()
    .from(schema.boards)
    .where(eq(schema.boards.id, boardId))
    .limit(1);
  const board = boardRows[0];
  if (!board) return null;

  const memberRows = await db
    .select({ role: schema.boardMembers.role })
    .from(schema.boardMembers)
    .where(
      and(eq(schema.boardMembers.boardId, boardId), eq(schema.boardMembers.userId, userId)),
    )
    .limit(1);
  const role = opts.ignoreMembership ? null : ((memberRows[0]?.role ?? null) as BoardRole | null);
  const wsRole = await workspaceRoleOf(userId, board.workspaceId);

  const deny: BoardAccess = {
    board, role, workspaceRole: wsRole,
    canRead: false, canWrite: false, canAdmin: false,
  };

  // 1. instance admin
  if (opts.isAdmin) return { ...deny, canRead: true, canWrite: true, canAdmin: true };

  // 2. explicit board membership
  if (role) {
    // board admins always admin; workspace admins admin any non-private board
    const admin =
      role === "admin" || (wsRole === "admin" && board.visibility !== "private");
    return {
      ...deny,
      canRead: true,
      canWrite: role !== "observer" || admin,
      canAdmin: admin,
    };
  }

  // 3. workspace admin (not on private boards they aren't a member of)
  if (wsRole === "admin" && board.visibility !== "private") {
    return { ...deny, canRead: true, canWrite: true, canAdmin: true };
  }

  // 4. workspace-visible
  if (board.visibility === "workspace" && wsRole) {
    return { ...deny, canRead: true };
  }

  // 5. team-visible
  if (board.visibility === "team" && wsRole) {
    const grants = await db
      .select({ teamId: schema.boardTeams.teamId })
      .from(schema.boardTeams)
      .where(eq(schema.boardTeams.boardId, boardId));
    if (grants.length) {
      const mine = await db
        .select({ teamId: schema.teamMembers.teamId })
        .from(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.userId, userId),
            inArray(schema.teamMembers.teamId, grants.map((g) => g.teamId)),
          ),
        )
        .limit(1);
      if (mine.length) return { ...deny, canRead: true };
    }
  }

  return null; // no access at all — board existence is not revealed
}

/** All board ids a user can SEE within one workspace (for the workspace home). */
export async function visibleBoardIds(
  userId: string,
  workspaceId: string,
  isAdmin: boolean,
): Promise<Set<string>> {
  const all = await db
    .select({ id: schema.boards.id, visibility: schema.boards.visibility })
    .from(schema.boards)
    .where(eq(schema.boards.workspaceId, workspaceId));
  if (!all.length) return new Set();

  const wsRole = await workspaceRoleOf(userId, workspaceId);
  const memberOf = new Set(
    (
      await db
        .select({ boardId: schema.boardMembers.boardId })
        .from(schema.boardMembers)
        .where(eq(schema.boardMembers.userId, userId))
    ).map((r) => r.boardId),
  );
  const myTeams = new Set(
    (
      await db
        .select({ teamId: schema.teamMembers.teamId })
        .from(schema.teamMembers)
        .where(eq(schema.teamMembers.userId, userId))
    ).map((r) => r.teamId),
  );
  const teamGrants = await db
    .select({ boardId: schema.boardTeams.boardId, teamId: schema.boardTeams.teamId })
    .from(schema.boardTeams)
    .where(inArray(schema.boardTeams.boardId, all.map((b) => b.id)));
  const teamVisible = new Set(
    teamGrants.filter((g) => myTeams.has(g.teamId)).map((g) => g.boardId),
  );

  const out = new Set<string>();
  for (const b of all) {
    if (isAdmin || memberOf.has(b.id)) out.add(b.id);
    else if (wsRole === "admin" && b.visibility !== "private") out.add(b.id);
    else if (b.visibility === "workspace" && wsRole) out.add(b.id);
    else if (b.visibility === "team" && wsRole && teamVisible.has(b.id)) out.add(b.id);
  }
  return out;
}

/**
 * Can this (other) user read the board? `false` for a nonexistent user too.
 * Used to vet card/checklist assignees and notification targets (M8): those
 * get card titles and board ids, so they must already be able to see them.
 */
export async function userCanReadBoard(userId: string, boardId: string): Promise<boolean> {
  const [u] = await db
    .select({ isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!u) return false;
  return !!(await boardAccess(userId, boardId, { isAdmin: u.isAdmin }))?.canRead;
}

/** all board ids this user can see, across every workspace they belong to */
export async function allVisibleBoards(userId: string, isAdmin: boolean): Promise<Set<string>> {
  const wsIds = isAdmin
    ? (await db.select({ id: schema.workspaces.id }).from(schema.workspaces)).map((w) => w.id)
    : (
        await db
          .select({ id: schema.workspaceMembers.workspaceId })
          .from(schema.workspaceMembers)
          .where(eq(schema.workspaceMembers.userId, userId))
      ).map((w) => w.id);
  const out = new Set<string>();
  for (const wsId of wsIds) {
    for (const id of await visibleBoardIds(userId, wsId, isAdmin)) out.add(id);
  }
  // guest boards (member of board but not its workspace)
  const guestRows = await db
    .select({ boardId: schema.boardMembers.boardId })
    .from(schema.boardMembers)
    .where(eq(schema.boardMembers.userId, userId));
  for (const r of guestRows) out.add(r.boardId);
  return out;
}
