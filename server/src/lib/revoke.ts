/**
 * Access revocation side effects (review H5). Removing a workspace membership
 * or a team grant used to change only that one row: board_members rows
 * survived (and perms.ts trusts them unconditionally), and open sockets kept
 * streaming the board. These helpers clean up both.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { boardAccess } from "./perms.js";
import { revalidateBoardRoom } from "../sockets/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Inside the removal transaction: delete every board role and team membership
 * the user holds in this workspace. Returns the workspace's board ids so the
 * caller can drop live sockets after commit.
 */
export async function stripWorkspaceAccess(tx: Tx, workspaceId: string, userId: string): Promise<string[]> {
  const boardIds = (
    await tx.select({ id: schema.boards.id }).from(schema.boards).where(eq(schema.boards.workspaceId, workspaceId))
  ).map((b) => b.id);
  if (boardIds.length) {
    await tx
      .delete(schema.boardMembers)
      .where(and(eq(schema.boardMembers.userId, userId), inArray(schema.boardMembers.boardId, boardIds)));
  }
  const teamIds = (
    await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.workspaceId, workspaceId))
  ).map((t) => t.id);
  if (teamIds.length) {
    await tx
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.userId, userId), inArray(schema.teamMembers.teamId, teamIds)));
  }
  return boardIds;
}

/** After commit: kick the user's sockets out of every board room they can no longer read. */
export async function dropSockets(boardIds: string[], userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  const who = new Set(userIds);
  for (const boardId of boardIds) await revalidateBoardRoom(boardId, who);
}

/**
 * After a team grant is lost (grant removed from a board, user removed from a
 * team, or team deleted): for each affected user who can no longer read the
 * board through any other path, delete their `observer` row and drop their
 * sockets.
 *
 * Only `observer` rows go: that is the role starring a board silently creates
 * (boards.ts /star), i.e. the residue of team-granted read access. member/
 * admin/guest rows were granted deliberately by a board admin and are kept;
 * deleting them could also orphan a board's last admin.
 */
export async function dropLostTeamAccess(boardIds: string[], userIds: string[]): Promise<void> {
  if (!boardIds.length || !userIds.length) return;
  for (const boardId of boardIds) {
    for (const userId of userIds) {
      const without = await boardAccess(userId, boardId, { ignoreMembership: true });
      if (without?.canRead) continue;
      await db
        .delete(schema.boardMembers)
        .where(
          and(
            eq(schema.boardMembers.boardId, boardId),
            eq(schema.boardMembers.userId, userId),
            eq(schema.boardMembers.role, "observer"),
          ),
        );
    }
  }
  await dropSockets(boardIds, userIds);
}
