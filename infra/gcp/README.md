# infra/gcp

Scripts for the shared GCP Cloud SQL instance (`waddling-main`) that backs the control
plane and the per-org DuckLake catalogs. Full background + architecture:
[`docs/gcp-cloud-sql.md`](../../docs/gcp-cloud-sql.md).

## Credential operations — use `credops.sh`

**`credops.sh` is how we rotate certs and passwords.** Don't hand-run the underlying
gcloud/wrangler commands — the tool encodes the ordering, verification, and the non-obvious
gotchas (re-passing cert ids on every Hyperdrive update, dual-password rotation, the
warm-replica window, `verify-ca`).

```bash
infra/gcp/credops.sh          # interactive menu (shows live cert + Hyperdrive state)
infra/gcp/credops.sh 3        # jump straight to op 3 (rotate DB password)
```

| # | Operation |
|---|---|
| 1 | Rotate client cert (mint → CF → Hyperdrive → gateway secrets → verify → offer retire) |
| 2 | Retire an old client cert |
| 3 | Rotate DB password (dual-password, zero-downtime) |
| 4 | Re-push gateway PEM secrets |
| 5 | Rotate server CA (create → distribute → cutover → rollback) |

Every mutation is confirmed; destructive steps need an explicit `y`. Requires `gcloud`
(authed to the project) + `wrangler` (authed to the CF account); `psql` for the optional
direct-libpq verification.

## Files

| Script | Purpose |
|---|---|
| `credops.sh` | **Interactive credential-ops menu — the supported entry point.** |
| `rotate-mtls.sh` | Non-interactive client-cert rotation primitive (CI-friendly; credops op 1 calls it). |
| `setup.sh` | One-time project/instance/API/Artifact-Registry/Secret-Manager setup. |
| `deploy-actor.sh` | Build + push + deploy the Rivet gateway actor to Cloud Run. |
| `deploy-app.sh` | Deploy the control-plane app. |

## Conventions

- Always pass `--project=project-bd87157a-f6fd-4d44-830` explicitly — the active gcloud
  config points at an unrelated project.
- Cert/password **values** never go in the repo. Resource **ids** (Hyperdrive, CF cert
  objects) are references and are listed in [`docs/gcp-cloud-sql.md`](../../docs/gcp-cloud-sql.md).
