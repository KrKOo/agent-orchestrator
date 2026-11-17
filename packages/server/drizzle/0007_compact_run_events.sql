-- Backports the runner's event compaction (runner/src/tool-updates.ts, slashRun's stdout) to stored
-- runs; mirrors it so the run view renders the same transcript from fewer, smaller events.
-- 1. Raw `omp -p` NDJSON stdout of slash runs (slash steps, slash chats in intervention steps): its
--    rendering is already stored as acp.update events.
DELETE FROM `run_events`
WHERE `type` = 'sandbox.log'
  AND json_extract(`payload`, '$.stream') = 'stdout'
  AND EXISTS (
    SELECT 1 FROM `runs`, json_each(`runs`.`definition`, '$.steps') AS `s`
    WHERE `runs`.`id` = `run_events`.`run_id`
      AND json_extract(`s`.`value`, '$.id') = `run_events`.`step_id`
      AND json_extract(`s`.`value`, '$.kind') IN ('slash', 'intervention')
  );
--> statement-breakpoint
-- 2. rawOutput snapshots of unfinished tool calls (each is superseded by the next one).
UPDATE `run_events`
SET `payload` = json_remove(`payload`, '$.update.rawOutput')
WHERE `type` = 'acp.update'
  AND json_extract(`payload`, '$.update.sessionUpdate') = 'tool_call_update'
  AND json_extract(`payload`, '$.update.status') IN ('pending', 'in_progress')
  AND json_type(`payload`, '$.update.rawOutput') IS NOT NULL;
--> statement-breakpoint
-- 3. Unfinished tool call updates equal to the previous update of the same tool call in the same step
--    (re-applying an update in the run view changes nothing).
DELETE FROM `run_events`
WHERE rowid IN (
  SELECT `rid` FROM (
    SELECT
      rowid AS `rid`,
      `payload`,
      json_extract(`payload`, '$.update.status') AS `status`,
      lag(`payload`) OVER (
        PARTITION BY `run_id`, `step_id`, json_extract(`payload`, '$.update.toolCallId')
        ORDER BY `seq`
      ) AS `prev`
    FROM `run_events`
    WHERE `type` = 'acp.update'
      AND json_extract(`payload`, '$.update.sessionUpdate') = 'tool_call_update'
  )
  WHERE `status` IN ('pending', 'in_progress') AND `payload` = `prev`
);
