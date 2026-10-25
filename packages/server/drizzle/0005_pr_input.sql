-- Pull requests became a flow input: PR-triggered flows (which had no inputs and read `inputs.pr`)
-- get an explicit `pr` input of type github_pull_request; the removed `trigger.postReview` is dropped.
-- Run snapshots are migrated too so retries of older PR runs still validate on the runner.
UPDATE `flows` SET `definition` = json_remove(
  json_set(`definition`, '$.inputs', json('[{"key":"pr","label":"Pull request","type":"github_pull_request","required":true}]')),
  '$.trigger.postReview'
)
WHERE json_extract(`definition`, '$.trigger.kind') = 'github_pull_request'
  AND NOT EXISTS (SELECT 1 FROM json_each(`definition`, '$.inputs') WHERE json_extract(`value`, '$.type') = 'github_pull_request');
--> statement-breakpoint
UPDATE `runs` SET `definition` = json_remove(
  json_set(`definition`, '$.inputs', json('[{"key":"pr","label":"Pull request","type":"github_pull_request","required":true}]')),
  '$.trigger.postReview'
)
WHERE json_extract(`definition`, '$.trigger.kind') = 'github_pull_request'
  AND NOT EXISTS (SELECT 1 FROM json_each(`definition`, '$.inputs') WHERE json_extract(`value`, '$.type') = 'github_pull_request');
