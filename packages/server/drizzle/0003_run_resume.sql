ALTER TABLE `runs` ADD `resume_from` integer;--> statement-breakpoint
UPDATE `runs` SET `resume_from` = NULL;
