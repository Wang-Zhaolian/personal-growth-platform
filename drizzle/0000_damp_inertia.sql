CREATE TABLE `browser_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commit_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "commit_checks_ok" CHECK("commit_checks"."ok" = 1)
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source` text NOT NULL,
	`source_text` text NOT NULL,
	`changes_json` text NOT NULL,
	`questions_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_drafts_owner_status` ON `drafts` (`owner_id`,`status`);--> statement-breakpoint
CREATE TABLE `history` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`record_id` text NOT NULL,
	`action` text NOT NULL,
	`occurred_text` text DEFAULT '' NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_history_owner_record` ON `history` (`owner_id`,`record_id`);--> statement-breakpoint
CREATE INDEX `idx_history_owner_created` ON `history` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`level` text NOT NULL,
	`category` text NOT NULL,
	`status` text NOT NULL,
	`parent_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`outcome` text DEFAULT '' NOT NULL,
	`links_json` text DEFAULT '[]' NOT NULL,
	`start_text` text DEFAULT '' NOT NULL,
	`due_date` text DEFAULT '' NOT NULL,
	`completed_text` text DEFAULT '' NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_records_owner_status` ON `records` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_records_owner_parent` ON `records` (`owner_id`,`parent_id`);