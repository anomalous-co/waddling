/**
 * The PostHog funnel star schema (TargetModel) in the `marketing` lake schema.
 *
 * Source-specific dims (event type, campaign, page) + the fact, plus the two
 * conformed dims (dim_date, dim_person). Surrogate keys are md5(natural_key)
 * computed with the SAME inline expression in both the dim and the fact, so the
 * fact resolves every FK without a join — pure function, join-order-independent,
 * rebuild-safe. Dims are still built before the fact (order[] below) so the
 * proof JOIN returns rows immediately.
 *
 * The fact is built from the uuid-deduped staging read (row_number() over uuid,
 * keep the latest) — the at-least-once safety net for double-sent buffers.
 */

import type { StarTable, TargetModel } from '../types';
import { dimDate, dimPerson } from './conformed';

/** The deduped staging read, reused by the fact and as a CTE seed elsewhere. */
function dedupedStaging(stagingGlob: string): string {
  return `
    SELECT * EXCLUDE (_rn) FROM (
      SELECT *, row_number() OVER (PARTITION BY uuid ORDER BY timestamp DESC) AS _rn
      FROM read_parquet('${stagingGlob}', union_by_name => true)
    ) WHERE _rn = 1
  `;
}

/**
 * dim_event_type — one row per event name, with a stage_category rolling the
 * taxonomy up to the visit→signup→activation→paid funnel stages.
 */
export const dimEventType: StarTable = {
  name: 'dim_event_type',
  kind: 'dim',
  sql: ({ stagingGlob }) => `
    CREATE OR REPLACE TABLE marketing.dim_event_type AS
    SELECT
      md5(event) AS event_type_key,
      event,
      CASE
        WHEN event = '$pageview' THEN 'marketing'
        WHEN event LIKE 'signup_%' THEN 'signup'
        WHEN event IN ('mcp_connect','first_query','query_executed','denial_hit') THEN 'activation'
        WHEN event LIKE 'upgrade_%' OR event LIKE 'checkout_%' THEN 'paid'
        ELSE 'other'
      END AS stage_category
    FROM (
      SELECT DISTINCT event
      FROM read_parquet('${stagingGlob}', union_by_name => true)
      WHERE event IS NOT NULL
    )
  `,
};

/**
 * dim_campaign — acquisition attribution. Key over the utm tuple + referrer;
 * concat_ws skips nulls so a row with only a referrer still keys distinctly.
 */
export const dimCampaign: StarTable = {
  name: 'dim_campaign',
  kind: 'dim',
  sql: ({ stagingGlob }) => `
    CREATE OR REPLACE TABLE marketing.dim_campaign AS
    SELECT DISTINCT
      md5(concat_ws('|', utm_source, utm_medium, utm_campaign, referrer)) AS campaign_key,
      utm_source,
      utm_medium,
      utm_campaign,
      referrer
    FROM read_parquet('${stagingGlob}', union_by_name => true)
  `,
};

/** dim_page — the page a marketing event happened on. */
export const dimPage: StarTable = {
  name: 'dim_page',
  kind: 'dim',
  // Page-less events (signup_completed, mcp_connect, …) get a deterministic
  // "(none)" member via the '' sentinel rather than a null key, so EVERY fact row
  // resolves to a dim_page row (no orphans). The fact computes page_key with the
  // identical expression. (dim_campaign gets this for free via concat_ws.)
  sql: ({ stagingGlob }) => `
    CREATE OR REPLACE TABLE marketing.dim_page AS
    SELECT DISTINCT
      md5(coalesce(pathname, current_url, '')) AS page_key,
      pathname,
      current_url
    FROM read_parquet('${stagingGlob}', union_by_name => true)
  `,
};

/**
 * fct_funnel_event — the grain is one (deduped) event. event_uuid is a
 * degenerate dimension; every FK is the SAME md5 expression as its dim, so no
 * join is needed to resolve SKs (rebuild-safe). Measures: is_conversion plus
 * the CTA detail carried for funnel-step analysis.
 */
export const fctFunnelEvent: StarTable = {
  name: 'fct_funnel_event',
  kind: 'fact',
  sql: ({ stagingGlob }) => `
    CREATE OR REPLACE TABLE marketing.fct_funnel_event AS
    WITH staged AS (${dedupedStaging(stagingGlob)})
    SELECT
      uuid                                                       AS event_uuid,
      timestamp                                                  AS event_ts,
      md5(coalesce(person_id, distinct_id))                      AS person_key,
      md5(event)                                                 AS event_type_key,
      md5(concat_ws('|', utm_source, utm_medium, utm_campaign, referrer)) AS campaign_key,
      md5(coalesce(pathname, current_url, ''))                   AS page_key,
      CAST(strftime(CAST(timestamp AS DATE), '%Y%m%d') AS INTEGER) AS date_key,
      event IN ('signup_completed','checkout_completed')         AS is_conversion,
      cta_location,
      cta_text
    FROM staged
  `,
};

/** The funnel star: conformed dims + source dims + fact, dims-before-fact. */
export const funnelStar: TargetModel = {
  schema: 'marketing',
  order: ['dim_date', 'dim_person', 'dim_event_type', 'dim_campaign', 'dim_page', 'fct_funnel_event'],
  tables: {
    dim_date: dimDate,
    dim_person: dimPerson,
    dim_event_type: dimEventType,
    dim_campaign: dimCampaign,
    dim_page: dimPage,
    fct_funnel_event: fctFunnelEvent,
  },
};
