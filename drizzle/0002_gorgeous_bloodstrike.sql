CREATE TABLE `model_connections` (
	`owner_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`selected_model` text NOT NULL,
	`verified_at` text,
	`is_default` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_connections_owner_provider` ON `model_connections` (`owner_id`,`provider_id`);