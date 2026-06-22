-- Cursor store for the ETL fleet. One row per pipeline (PipelineSpec.cursorKey).
--
-- watermark    : the source high-water mark (max event timestamp pulled, ISO-8601).
-- last_run_at  : when the most recent run was dispatched (drives the stale-running guard).
-- last_status  : 'ok' | 'error' from the most recent completed run.
-- rows         : records pulled on the most recent run (observability).
-- running      : overlap guard. 1 while a run is in flight; cleared by the workflow
--                (clean OR errored). The dispatcher skips a pipeline whose running=1
--                unless last_run_at is older than the stale threshold.
--
-- Apply: wrangler d1 execute pipelines-cursors --file migrations/0001_cursors.sql --remote
CREATE TABLE IF NOT EXISTS cursor (
  pipeline_id  TEXT PRIMARY KEY,
  watermark    TEXT,
  last_run_at  TEXT,
  last_status  TEXT,
  rows         INTEGER,
  running      INTEGER NOT NULL DEFAULT 0
);
