ALTER TABLE "boards" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "mirror_of_card_id" uuid;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_share_token_unique" UNIQUE("share_token");