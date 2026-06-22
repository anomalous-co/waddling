/**
 * Conformed dimensions — shared across every target model.
 *
 * `dim_date` and `dim_person` are not funnel-specific: a second source reuses
 * them by listing the same StarTable in its TargetModel.order. Surrogate keys
 * are deterministic md5(natural_key) computed with the SAME inline expression
 * the fact uses, so FK resolution is a pure function — no join, rebuild-safe.
 *
 * Every statement is CREATE OR REPLACE TABLE (idempotent: a full rebuild each
 * run is correct because the inputs are append-only and the SKs are stable).
 */

import type { StarTable } from '../types';

/**
 * dim_date — calendar attributes, keyed by yyyymmdd integer. Built from the
 * distinct event dates present in staging (so the proof JOIN has matching keys);
 * a generated series would also work but ties the grain to actual data.
 */
export const dimDate: StarTable = {
  name: 'dim_date',
  kind: 'dim',
  conformed: true,
  sql: ({ stagingGlob }) => `
    CREATE OR REPLACE TABLE marketing.dim_date AS
    WITH d AS (
      SELECT DISTINCT CAST(timestamp AS DATE) AS date
      FROM read_parquet('${stagingGlob}', union_by_name => true)
      WHERE timestamp IS NOT NULL
    )
    SELECT
      CAST(strftime(date, '%Y%m%d') AS INTEGER) AS date_key,
      date,
      CAST(strftime(date, '%Y') AS INTEGER)     AS year,
      CAST(ceil(month(date) / 3.0) AS INTEGER)  AS quarter,
      month(date)                               AS month,
      dayofweek(date)                           AS dow
    FROM d
  `,
};

/**
 * dim_person — one row per person. Key = md5(coalesce(person_id, distinct_id)):
 * a merged person carries the same person_id across its events, so the SK is
 * stable post-merge. email/name only where PostHog already stitched them onto
 * the person; it's the customer's own governed table, gated by birdshot.
 */
export const dimPerson: StarTable = {
  name: 'dim_person',
  kind: 'dim',
  conformed: true,
  sql: ({ stagingGlob }) => `
    CREATE OR REPLACE TABLE marketing.dim_person AS
    WITH ev AS (
      SELECT
        coalesce(person_id, distinct_id) AS natural_key,
        person_id,
        distinct_id,
        timestamp,
        person_id IS NOT NULL AS is_identified,
        email,
        name
      FROM read_parquet('${stagingGlob}', union_by_name => true)
      WHERE coalesce(person_id, distinct_id) IS NOT NULL
    )
    SELECT
      md5(natural_key)                       AS person_key,
      any_value(person_id)                   AS person_id,
      any_value(distinct_id)                 AS distinct_id,
      min(timestamp)                         AS first_seen_at,
      max(timestamp)                         AS last_seen_at,
      bool_or(is_identified)                 AS is_identified,
      max(email)                             AS email,
      max(name)                              AS name
    FROM ev
    GROUP BY natural_key
  `,
};
