-- Migration 013 — policy-version cache on waddling.datalake.
-- Apply AFTER 012. Idempotent + re-run-safe.
--
-- WHY: the dynamic-ACL refresh alarm (Step 11) polls the gateway's per-datalake
-- director on a cadence and needs to know whether the compiled policy has changed
-- since the last push WITHOUT recompiling + hashing on every tick. These two
-- columns cache the result of compileEndpointPolicy + policyVersionFor:
--
--   policy_version     TEXT         — the `<grantVersion>-<authVersion>` content hash
--                                     (lib/policy-version.ts). NULL ⇒ never compiled
--                                     (treated as "must push" by the alarm).
--   policy_compiled_at TIMESTAMPTZ  — when policy_version was last computed.
--
-- Bumped by recompileAndPush (the ACL-CRUD + refresh-policy path) AND by
-- GET /datalakes/:id/policy (the alarm's poll target), so a direct DB edit to
-- acl_rule (which bypasses recompileAndPush) is still picked up: the alarm's
-- next /policy call recompiles, detects a version change vs the cached row, and
-- re-pushes. The cached column is an optimization (one-column poll), not a source
-- of truth — the snapshot itself is always recompiled on demand from acl_rule.
--
-- No FK, no CHECK: this is a denormalized cache of a computed value.

DO $$
BEGIN
  IF to_regclass('waddling.datalake') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'waddling' AND table_name = 'datalake' AND column_name = 'policy_version'
     ) THEN
    ALTER TABLE waddling.datalake
      ADD COLUMN policy_version TEXT;
  END IF;
  IF to_regclass('waddling.datalake') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'waddling' AND table_name = 'datalake' AND column_name = 'policy_compiled_at'
     ) THEN
    ALTER TABLE waddling.datalake
      ADD COLUMN policy_compiled_at TIMESTAMPTZ;
  END IF;
END $$;
