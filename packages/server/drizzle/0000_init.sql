CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`file` text NOT NULL,
	`line` integer NOT NULL,
	`end_line` integer,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`rule_id` text
);
--> statement-breakpoint
CREATE INDEX `findings_run_idx` ON `findings` (`run_id`);--> statement-breakpoint
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`definition` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`step_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `run_steps` (
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`idx` integer NOT NULL,
	`status` text NOT NULL,
	`output` text,
	`structured` text,
	`started_at` integer,
	`finished_at` integer,
	PRIMARY KEY(`run_id`, `step_id`)
);
--> statement-breakpoint
CREATE TABLE `runners` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`owner_user_id` text,
	`labels` text NOT NULL,
	`capabilities` text,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runners_token_hash_unique` ON `runners` (`token_hash`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`flow_version` integer NOT NULL,
	`definition` text NOT NULL,
	`inputs` text NOT NULL,
	`status` text NOT NULL,
	`trust` text NOT NULL,
	`runner_id` text,
	`created_by` text,
	`trigger_kind` text NOT NULL,
	`dedupe_key` text,
	`github` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_dedupe_key_unique` ON `runs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_flow_idx` ON `runs` (`flow_id`,`created_at`);