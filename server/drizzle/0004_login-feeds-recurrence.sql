CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"require_2fa" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "recurrence" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_pending_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "feed_token" text;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_identity_idx" ON "users" USING btree ("oidc_issuer","oidc_subject");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_feed_token_unique" UNIQUE("feed_token");--> statement-breakpoint
-- The single instance_settings row (code always reads/updates id = 1).
INSERT INTO "instance_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
