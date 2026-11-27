CREATE TABLE `task_messages` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`ts` integer NOT NULL,
	`run_id` text,
	`event` text,
	`choices` text,
	`choice` text,
	`answer_to` integer,
	PRIMARY KEY(`task_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text,
	`settings` text NOT NULL,
	`integration` text NOT NULL,
	`inbox_acked_seq` integer DEFAULT 0 NOT NULL,
	`manager_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `flows` ADD `task_id` text;--> statement-breakpoint
ALTER TABLE `flows` ADD `origin` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `task_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `role` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `intervention_handler` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `overrides` text;--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `runs` (`task_id`,`created_at`);
