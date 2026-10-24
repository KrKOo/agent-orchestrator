ALTER TABLE `runs` ADD `workspace` text;--> statement-breakpoint
UPDATE `runs` SET `workspace` = (
  SELECT json_extract(`payload`, '$.workspace')
  FROM `run_events`
  WHERE `run_events`.`run_id` = `runs`.`id`
    AND `type` = 'run.status'
    AND json_extract(`payload`, '$.workspace') IS NOT NULL
  ORDER BY `seq` LIMIT 1
) WHERE `workspace` IS NULL;