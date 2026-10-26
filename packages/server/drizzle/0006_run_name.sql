ALTER TABLE `runs` ADD `name` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `auto_name` integer DEFAULT 0 NOT NULL;
