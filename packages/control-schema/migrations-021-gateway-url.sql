-- Per-endpoint gateway addressing. Each datalake gets its own private Cloud Run gateway
-- (gw-<slug>, max-instances=1), deployed by the provisioner at create. gateway_url is that
-- service's URL; control-api targets it (and mints an identity token for it) when pushing
-- birdshot snapshots / revocations. NULL = legacy/unprovisioned endpoint → falls back to the
-- single GATEWAY_BASE_URL bring-up gateway.
ALTER TABLE waddling.datalake ADD COLUMN IF NOT EXISTS gateway_url TEXT;
