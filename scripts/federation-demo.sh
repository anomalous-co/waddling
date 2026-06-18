#!/usr/bin/env bash
# Two-instance birdshot federation demo: each instance holds DISTINCT fake PII
# (contacts/addresses/memories) and a distinct local user; birdshot lets a quack
# peer read the shared `todos` but DENIES the peer's PII.
#
# Prereq: build the extension first (birdshot/setup-build.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

EXT="$(pwd)/birdshot/build/release/extension/birdshot/birdshot.duckdb_extension"
if [ ! -f "$EXT" ]; then
  echo "birdshot extension not built. Run: (cd birdshot && ./setup-build.sh)" >&2
  exit 1
fi
COMMON="BIRDSHOT_EXTENSION_PATH=$EXT"

env $COMMON PG_PORT=16432 AUTH_PG_PORT=16442 QUACK_PORT=19494 PEER_QUACK_PORT=19495 \
  QUACK_TOKEN=token-a PEER_QUACK_TOKEN=token-b DATA_DIR=./pgdata-demo-a INSTANCE=A BETTER_AUTH_SECRET=instance-a-secret-0123456789abcdef \
  node --experimental-strip-types packages/db/src/pii-demo.ts &
env $COMMON PG_PORT=16433 AUTH_PG_PORT=16443 QUACK_PORT=19495 PEER_QUACK_PORT=19494 \
  QUACK_TOKEN=token-b PEER_QUACK_TOKEN=token-a DATA_DIR=./pgdata-demo-b INSTANCE=B BETTER_AUTH_SECRET=instance-b-secret-fedcba9876543210 \
  node --experimental-strip-types packages/db/src/pii-demo.ts &
wait

rm -rf pgdata-demo-a pgdata-demo-a-auth pgdata-demo-a-private pgdata-demo-b pgdata-demo-b-auth pgdata-demo-b-private
