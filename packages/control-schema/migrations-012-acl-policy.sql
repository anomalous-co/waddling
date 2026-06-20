-- Migration 012 — waddling.acl_policy: per-subject allowlists for NON-catalog
-- resources. Apply AFTER 011. Idempotent + re-run-safe.
--
-- WHY: migration 010 generalized acl_rule to the full capability taxonomy, but
-- acl_rule is keyed to a catalog resource (schema.table) — it cannot express the
-- resources the new capabilities actually gate: a read_source/copy URI, an
-- INSTALL/LOAD extension name, an ATTACH target. birdshot matches those via
-- per-role POLICY allowlists (birdshot_add_source_policy / _dest_policy /
-- _ext_policy / _attach_policy), NOT table RefMatch. acl_policy is the control-
-- plane row that compiles into exactly those calls.
--
-- HARD INVARIANT (birdshot, Phase 2): a non-catalog resource that cannot be
-- pinned to a CONSTANT literal is DENIED (un-pinned source under live egress =
-- exfil/SSRF). A policy here only WIDENS what an already-constant literal may
-- match; it never relaxes the constant-literal requirement.
--
-- SUBJECTS mirror acl_rule (010): 'agent' (direct, e.g. an autonomous etl agent),
-- 'user' (the derivation source — intersected with a delegation scope, never a
-- birdshot principal itself), 'org' (org-wide). Derived agent policies are NEVER
-- persisted; effective = owner's policies ∩ delegation, recomputed every compile.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'waddling' AND table_name = 'acl_policy'
  ) THEN
    CREATE TABLE waddling.acl_policy (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id       TEXT NOT NULL,                          -- → auth.organization.id

      -- Resource scope (NULL datalake = all datalakes for this subject).
      datalake_id  TEXT REFERENCES waddling.datalake(id) ON DELETE CASCADE,

      -- Subject (who the policy applies to). Exactly mirrors acl_rule (010).
      subject_kind TEXT NOT NULL DEFAULT 'agent'
        CHECK (subject_kind IN ('agent','user','org')),
      agent_id     TEXT REFERENCES waddling.agent(id) ON DELETE CASCADE, -- NULL for user/org
      user_id      TEXT,                                   -- → auth.user.id (no FK: cross-schema)

      -- The non-catalog resource class this allowlist gates.
      policy_kind  TEXT NOT NULL
        CHECK (policy_kind IN ('source','dest','extension','attach')),
      -- The capability the policy authorizes. policy_kind implies a family
      -- (source ← read_source/copy_from; dest ← copy_to; extension ← install/load;
      -- attach ← attach) but we store the explicit capability for filtering/audit.
      capability   TEXT NOT NULL
        CHECK (capability IN (
          'read_source','copy_to','copy_from','attach','install','load'
        )),

      -- The allowlist pattern birdshot matches the constant literal against:
      --   source/dest/attach → host/domain (https-only; subdomains match)
      --   extension          → extension name
      pattern      TEXT NOT NULL,

      -- Optional expiry on the policy (NULL = no expiry).
      expires_at   TIMESTAMPTZ,

      -- Audit
      created_by   TEXT NOT NULL,                          -- auth.user.id who created it
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

      -- A subject must be resolvable: agent_id for 'agent', user_id for 'user',
      -- neither required for 'org' (org_id carries it).
      CONSTRAINT acl_policy_subject_resolvable CHECK (
        (subject_kind = 'agent' AND agent_id IS NOT NULL) OR
        (subject_kind = 'user'  AND user_id  IS NOT NULL) OR
        (subject_kind = 'org')
      )
    );
  END IF;
END $$;

-- Lookup index for the compile spine: all policies for a datalake, by subject.
CREATE INDEX IF NOT EXISTS acl_policy_lookup_idx
  ON waddling.acl_policy (datalake_id, subject_kind, user_id, agent_id);
