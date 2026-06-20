#!/usr/bin/env bash
# Rebuild + redeploy the waddling-dataplane Worker AND its container images.
#
# WHY THIS EXISTS (the pain this scripts away):
#   `wrangler deploy` builds the GatewayDO/WorkspaceSandbox/QuackboardDO container
#   images from Dockerfiles (apps/cf-stagec-gw-probe/container/, ...-ws-probe/).
#   The build is driven by local Docker/BuildKit. BuildKit CONTENT-ADDRESSES the
#   `COPY gateway/gateway-src/` + `COPY gateway/entrypoint.mjs` layers, so when a
#   source file in the build context changes, the layer hash SHOULD change and bust
#   the cache. In practice BuildKit frequently returns a CACHED layer whose manifest
#   digest matches a PREVIOUSLY-PUSHED remote image, so wrangler prints
#     "Image already exists remotely, skipping push"
#   and the container app's `image:` reference is NOT updated → no rollout → the
#   running containers keep serving the OLD image. A deploy that looks successful
#   silently ships nothing.
#
#   The reliable fix (proven during Step 5 of the gateway-lifecycle plan): clear
#   BuildKit's cache first, forcing wrangler's build to re-COPY the context and
#   produce a genuinely new manifest digest, which wrangler then pushes AND uses to
#   update the container app spec (triggering a rollout). This script does that.
#
# WHEN TO USE:
#   - Any change to files under apps/cf-stagec-gw-probe/container/  (gateway image:
#       gateway-src/*.ts, entrypoint.mjs, Dockerfile, birdshot binary)
#   - Any change to files under apps/cf-stagec-ws-probe/container/  (workspace image)
#   - When a `pnpm deploy` "succeeds" but the new container behavior isn't live
#     (symptom: running container returns 404 for a route you just added).
#
# WHEN YOU DO NOT NEED THIS:
#   - Pure Worker (src/index.ts) changes with NO container-image change: `pnpm deploy`
#     is enough — the Worker bundle updates independently of the container images.
#   - But if unsure, run this — the prune is cheap (~seconds) and the deploy is
#     idempotent.
#
# AFTER DEPLOY: existing RUNNING containers are NOT automatically replaced. A warm
#   replica keeps its old image until it cold-boots. To force a specific replica onto
#   the new image, destroy it (POST /api/cp/datalakes/:id/replicas/:n/destroy) then
#   push a snapshot (POST /:id/refresh-policy) or wake it (POST /:n/wake) — the
#   re-spawned container boots from the new image.
set -euo pipefail

echo "→ pruning Docker BuildKit cache (forces a real image push, not the"
echo "  'Image already exists remotely, skipping push' dedup that silently"
echo "  ships nothing when gateway-src/entrypoint changed)…"
docker builder prune -af

echo "→ deploying waddling-dataplane (Worker + rebuilt container images)…"
exec npx wrangler deploy "$@"
