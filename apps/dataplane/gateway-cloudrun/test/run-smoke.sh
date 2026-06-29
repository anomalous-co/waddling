#!/usr/bin/env bash
# Orchestrates the local smoke test: a throwaway Postgres (DuckLake catalog) + the smoke
# container (real birdshot, linux/amd64). Run from the gateway-cloudrun dir: ./test/run-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

NET=waddling-smoke-net
PG=waddling-smoke-pg
cleanup() { docker rm -f "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$PG" >/dev/null 2>&1 || true
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=lake postgres:16 >/dev/null
echo "waiting for postgres..."
until docker exec "$PG" pg_isready -U test -d lake >/dev/null 2>&1; do sleep 1; done

docker build --platform=linux/amd64 -f test/Dockerfile.smoke -t waddling-gw-smoke . >/dev/null
docker run --rm --platform=linux/amd64 --network "$NET" \
  -e SMOKE_PG_DSN="host=${PG} port=5432 dbname=lake user=test password=test" \
  waddling-gw-smoke
