/**
 * D1 cursor store — one queryable row per pipeline.
 *
 * Chosen over KV: the watermark advance must be a monotonic guarded UPDATE
 * (`watermark < ?`), which needs strong consistency. KV's eventual consistency
 * could regress a watermark and re-pull (or skip) a window. D1 is also the
 * dispatcher's overlap backstop — the `running` flag is the primary guard
 * against two instances of the same pipeline racing.
 *
 * Schema (migrations/0001_cursors.sql):
 *   cursor(pipeline_id PK, watermark, last_run_at, last_status, rows, running)
 */

export interface CursorRow {
  pipeline_id: string;
  watermark: string | null;
  last_run_at: string | null;
  last_status: string | null;
  rows: number | null;
  running: number;
}

export class CursorStore {
  constructor(private db: D1Database) {}

  async read(pipelineId: string): Promise<CursorRow | null> {
    const row = await this.db
      .prepare('SELECT * FROM cursor WHERE pipeline_id = ?')
      .bind(pipelineId)
      .first<CursorRow>();
    return row ?? null;
  }

  /** Mark the pipeline running. Upserts the row so first-run pipelines work. */
  async markRunning(pipelineId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO cursor (pipeline_id, last_run_at, running)
           VALUES (?, ?, 1)
         ON CONFLICT(pipeline_id) DO UPDATE SET last_run_at = excluded.last_run_at, running = 1`,
      )
      .bind(pipelineId, now)
      .run();
  }

  /** Clear the running flag and record the run outcome. */
  async clearRunning(
    pipelineId: string,
    status: string,
    rows: number | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE cursor SET running = 0, last_status = ?, rows = ? WHERE pipeline_id = ?`,
      )
      .bind(status, rows, pipelineId)
      .run();
  }

  /**
   * Advance the watermark monotonically. The guard (`watermark IS NULL OR
   * watermark < ?`) makes a stale/duplicate advance a no-op, so an at-least-once
   * workflow retry can't regress the cursor.
   */
  async advance(pipelineId: string, watermark: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE cursor SET watermark = ?
           WHERE pipeline_id = ? AND (watermark IS NULL OR watermark < ?)`,
      )
      .bind(watermark, pipelineId, watermark)
      .run();
  }
}
