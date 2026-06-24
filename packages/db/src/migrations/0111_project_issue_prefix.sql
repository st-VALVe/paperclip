ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "issue_prefix" text;
--> statement-breakpoint
UPDATE "projects" SET "issue_prefix" = 'PB' WHERE "id" = 'f7700e35-69aa-4d95-adb0-e0af91ed5aa2' AND "issue_prefix" IS NULL;
