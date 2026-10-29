CREATE TABLE `model_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`base_model_id` text NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`system_prompt` text,
	`params` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_profiles_user_idx` ON `model_profiles` (`user_id`);