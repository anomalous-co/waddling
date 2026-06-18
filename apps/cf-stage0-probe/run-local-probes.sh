#!/usr/bin/env bash
# Stage 0 local probes (#2, #3, #4) — NO Cloudflare account required.
#
# Builds the linux/amd64 workspace-sidecar image (FROM cloudflare/sandbox) and runs:
#   #2  extensions load in-container (DuckDB v1.5.3 + quack + httpfs) + birdshot loads
#   #3  isolation levers identical in-container (s3/http blocked "by configuration",
#       unsigned off, lever irreversible, lake TOKEN unreadable via secrets/settings,
#       sidecar /proc env secret-free)
#   #4  native encryption + a CROSS-CONTAINER file round-trip (the R2 stand-in):
#       container #1 writes an encrypted workspace; we copy it out to the host and
#       into container #2; container #2 reopens it with the key (and wrong key fails).
#
# Probe #1 (the quack-over-443-under-CF-egress GATE) is NOT here — it requires a real
# Cloudflare deploy. See worker/README.md.
set -euo pipefail

cd "$(dirname "$0")"
IMAGE="cf-stage0-probe:local"
PLATFORM="linux/amd64"
WORK="$(mktemp -d)"
# The cloudflare/sandbox base image isolates the container filesystem and does NOT
# reflect host BIND mounts back to the host. A NAMED Docker volume, however, is
# honored AND shared across separate container instances — which is what we want:
# it crosses the container boundary through external storage, a faithful stand-in
# for the per-team R2 round-trip (container #1 PUTs, a fresh container #2 GETs).
VOL="cf-stage0-roundtrip-$$"
docker volume create "$VOL" >/dev/null
trap 'rm -rf "$WORK"; docker volume rm "$VOL" >/dev/null 2>&1 || true' EXIT

echo "==================================================================="
echo " Stage 0 local probes — building $IMAGE for $PLATFORM"
echo "==================================================================="
docker build --platform="$PLATFORM" -t "$IMAGE" ./container

# NOTE: the cloudflare/sandbox base image's ENTRYPOINT is the in-container process
# server (it stays running after spawning a child and routes its stdout to a JSON
# logger). For the OFFLINE probes we want our scripts to run directly and exit, so
# we override the entrypoint to `node`. On the real CF platform the server
# entrypoint is exactly what we WANT — that's what containerFetch/exec talk to,
# and what probe #1 exercises.
RUN="docker run --rm --platform=$PLATFORM --entrypoint node"

echo
echo "=== Sanity: arch + libc + DuckDB binding inside the image ==="
$RUN "$IMAGE" -e 'const d=require("detect-libc"); console.log("arch="+process.arch+" libc="+(d.familySync?d.familySync():"?")); require("@duckdb/node-api"); console.log("@duckdb/node-api loads")'
docker run --rm --platform="$PLATFORM" --entrypoint sh "$IMAGE" -c 'echo -n "bindings: "; ls node_modules/@duckdb/ | tr "\n" " "; echo'

echo
echo "==================================================================="
echo " Probe #2 (birdshot half): load published birdshot on this base image"
echo "==================================================================="
# Needs network egress to https://ext.getwaddling.com (host network is fine here —
# this is the OFFLINE half; the egress RESTRICTION is what probe #1 proves on CF).
set +e
$RUN "$IMAGE" birdshot-check.mjs
BIRDSHOT_RC=$?
set -e
case "$BIRDSHOT_RC" in
  0) echo "  birdshot: PASS (loads on this base image)";;
  2) echo "  birdshot: PENDING (CDN unreachable from this environment — not a defect)";;
  *) echo "  birdshot: FAIL (see VERDICT above)";;
esac

echo
echo "==================================================================="
echo " Probes #2/#3/#4 (in-container) + write encrypted workspace for round-trip"
echo "==================================================================="
# Mount a host dir as /data; the full probe writes OUT_DB there so we can copy it
# into a SECOND, fresh container (the cross-container R2 stand-in).
$RUN -e OUT_DB=/data/ws.duckdb -v "$VOL:/data" "$IMAGE" probe.mjs

echo
echo "  copy the encrypted file OUT to the host to inspect the on-disk header:"
# `docker create` a throwaway container on the volume, then `docker cp` out of it.
CID="$(docker create --platform="$PLATFORM" -v "$VOL:/data" "$IMAGE")"
docker cp "$CID:/data/ws.duckdb" "$WORK/ws.duckdb" >/dev/null
docker rm "$CID" >/dev/null
ls -la "$WORK/ws.duckdb"
echo "  on-disk header (host side, must NOT be 'DUCK'):"
head -c 16 "$WORK/ws.duckdb" | od -c | head -1

echo
echo "==================================================================="
echo " Probe #4 (cross-container): reopen in a FRESH container (R2 stand-in)"
echo "==================================================================="
# A DIFFERENT container instance opens the file written above (shared only via the
# named volume — no other shared state) with the key.
$RUN -e PROBE_MODE=reopen -e IN_DB=/data/ws.duckdb -v "$VOL:/data" "$IMAGE" probe.mjs

echo
echo "==================================================================="
echo " Local probes complete. Probe #1 (the GATE) still PENDING a CF deploy."
echo " See apps/cf-stage0-probe/worker/README.md."
echo "==================================================================="
