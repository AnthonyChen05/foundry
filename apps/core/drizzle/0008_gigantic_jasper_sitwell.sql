CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`outcome` text NOT NULL,
	`meta` text
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit` (`at`);