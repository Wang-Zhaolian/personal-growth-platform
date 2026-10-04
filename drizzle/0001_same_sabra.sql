CREATE TABLE `daily_habits` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`target_amount` real NOT NULL,
	`unit` text NOT NULL,
	`estimated_minutes` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_daily_habits_owner` ON `daily_habits` (`owner_id`,`archived`);--> statement-breakpoint
CREATE TABLE `daily_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`task_date` text NOT NULL,
	`available_minutes` integer NOT NULL,
	`focus` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_daily_plans_owner_date` ON `daily_plans` (`owner_id`,`task_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daily_plans_unique_day` ON `daily_plans` (`owner_id`,`task_date`);--> statement-breakpoint
CREATE TABLE `daily_task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`task_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`previous_amount` real NOT NULL,
	`new_amount` real NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_daily_task_events_owner_task` ON `daily_task_events` (`owner_id`,`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daily_task_events_idempotency` ON `daily_task_events` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `daily_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`record_id` text,
	`habit_id` text,
	`unit` text DEFAULT '次' NOT NULL,
	`target_amount` real NOT NULL,
	`completed_amount` real DEFAULT 0 NOT NULL,
	`estimated_minutes` integer DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`carryover_key` text NOT NULL,
	`source_task_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'suggested' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_daily_tasks_owner_plan` ON `daily_tasks` (`owner_id`,`plan_id`);--> statement-breakpoint
CREATE INDEX `idx_daily_tasks_owner_carryover` ON `daily_tasks` (`owner_id`,`carryover_key`);--> statement-breakpoint
ALTER TABLE `records` ADD `priority` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `records` ADD `progress_unit` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `records` ADD `target_amount` real;--> statement-breakpoint
ALTER TABLE `records` ADD `initial_amount` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `records` ADD `progress_weight` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `records` ADD `estimated_minutes` integer;