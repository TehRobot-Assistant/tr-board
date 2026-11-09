CREATE TABLE "automation_due_fired" (
	"rule_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_due_fired_rule_id_card_id_pk" PRIMARY KEY("rule_id","card_id")
);
--> statement-breakpoint
CREATE TABLE "board_stars" (
	"board_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_stars_board_id_user_id_pk" PRIMARY KEY("board_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "automation_due_fired" ADD CONSTRAINT "automation_due_fired_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_due_fired" ADD CONSTRAINT "automation_due_fired_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_stars" ADD CONSTRAINT "board_stars_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_stars" ADD CONSTRAINT "board_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_stars_user_idx" ON "board_stars" USING btree ("user_id");--> statement-breakpoint
-- M7: stars move out of board_members into board_stars.
INSERT INTO "board_stars" ("board_id", "user_id") SELECT "board_id", "user_id" FROM "board_members" WHERE "starred" ON CONFLICT DO NOTHING;--> statement-breakpoint
-- M7: /star used to insert an observer row for any reader. Drop the starred
-- observer rows that grant nothing today (the user can read the board through
-- workspace/team visibility anyway); those are the rows that would keep
-- access alive after a switch to private. Starred observers with no other path
-- are kept: they may have been added deliberately (e.g. an outside observer).
DELETE FROM "board_members" bm USING "boards" b
WHERE bm."board_id" = b."id" AND bm."role" = 'observer' AND bm."starred"
  AND EXISTS (
    SELECT 1 FROM "workspace_members" wm
    WHERE wm."workspace_id" = b."workspace_id" AND wm."user_id" = bm."user_id" AND (
      (wm."role" = 'admin' AND b."visibility" <> 'private')
      OR b."visibility" = 'workspace'
      OR (b."visibility" = 'team' AND EXISTS (
        SELECT 1 FROM "board_teams" bt JOIN "team_members" tm ON tm."team_id" = bt."team_id"
        WHERE bt."board_id" = b."id" AND tm."user_id" = bm."user_id"))
    )
  );--> statement-breakpoint
-- L7: mirrors whose source is already gone ("source deleted" ghosts) would
-- violate the new FK. DELETE /api/cards/:id already deleted mirrors with
-- their source; this applies the same rule to the ones the cascades missed.
DELETE FROM "cards" c WHERE c."mirror_of_card_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "cards" s WHERE s."id" = c."mirror_of_card_id");--> statement-breakpoint
-- M2: a mirror row's own title was a copy of the source title, readable by
-- everyone on the target board. The face now comes only from the access-
-- checked snapshot, so the stored title becomes a neutral placeholder.
UPDATE "cards" SET "title" = 'Mirrored card' WHERE "mirror_of_card_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_mirror_of_card_id_cards_id_fk" FOREIGN KEY ("mirror_of_card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_mirror_of_idx" ON "cards" USING btree ("mirror_of_card_id");--> statement-breakpoint
ALTER TABLE "board_members" DROP COLUMN "starred";