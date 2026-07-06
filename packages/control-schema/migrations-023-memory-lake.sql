-- One memory lake (quackboard) per org.
--
-- The quackboard row is now auto-provisioned (lazily on first memory-tool call and
-- eagerly by onboarding), so concurrent first-touch requests could otherwise race
-- two rows in; prepareQbContext would then silently serve the older one while the
-- newer sat orphaned. The partial unique index makes creation race-safe: inserts go
-- through ON CONFLICT DO NOTHING and re-select the winner.
-- Drop any duplicate boards first or the index build fails. Safe: prepareQbContext
-- has only ever served the OLDEST board per org (ORDER BY created_at ASC LIMIT 1),
-- so newer duplicates were unreachable orphans.
DELETE FROM waddling.datalake d
 USING waddling.datalake keep
 WHERE d.kind = 'quackboard' AND keep.kind = 'quackboard'
   AND d.org_id = keep.org_id
   AND (d.created_at, d.id) > (keep.created_at, keep.id);

CREATE UNIQUE INDEX IF NOT EXISTS datalake_one_quackboard_per_org
  ON waddling.datalake (org_id)
  WHERE kind = 'quackboard';
