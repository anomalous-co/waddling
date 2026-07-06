#!/usr/bin/env bash
# Smoke-test the private embeddings service AND measure the three Phase-2 spike gates:
#   1. output dim (must be 2560 → sets the FLOAT[2560] vector column)
#   2. cold-start latency (scale-from-zero: validates the "embed is async, never in write path")
#   3. warm throughput (batch embed)
#
# The service is private (--no-allow-unauthenticated), so we tunnel through `gcloud run services
# proxy`, which authenticates with your gcloud identity and exposes it on localhost. You need
# roles/run.invoker on the service (owners have it). Run: ./smoke.sh
set -euo pipefail

PROJECT="${PROJECT:-project-bd87157a-f6fd-4d44-830}"
GPU_REGION="${GPU_REGION:-us-central1}"
SERVICE="${SERVICE:-embeddings}"
PORT="${PORT:-8899}"

echo "==> opening authenticated proxy to ${SERVICE} on :${PORT}"
gcloud run services proxy "${SERVICE}" --project="${PROJECT}" --region="${GPU_REGION}" --port="${PORT}" >/tmp/embed-proxy.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
for i in $(seq 30); do curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1 && break; sleep 1; done

echo "==> [gate 1+2] cold request (this triggers scale-from-zero; time includes cold start)"
COLD_START=$(date +%s)
DIM=$(curl -s "http://localhost:${PORT}/embed" \
  -H 'content-type: application/json' \
  -d '{"inputs":"Instruct: Retrieve relevant memories\nQuery:deployment runbook for the gateway"}' \
  | python3 -c 'import sys,json; v=json.load(sys.stdin); print(len(v[0]))')
COLD_END=$(date +%s)
echo "    output dim = ${DIM}   (expect 2560)"
echo "    cold-path wall time = $((COLD_END - COLD_START))s"

echo "==> [gate 3] warm batch throughput (8 docs)"
# macOS/BSD `date` has no %N (ms); use python for a portable millisecond clock.
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
WARM_START=$(now_ms)
curl -s "http://localhost:${PORT}/embed" \
  -H 'content-type: application/json' \
  -d '{"inputs":["doc one","doc two","doc three","doc four","doc five","doc six","doc seven","doc eight"]}' \
  | python3 -c 'import sys,json; v=json.load(sys.stdin); print(f"    embedded {len(v)} docs, dim {len(v[0])}")'
WARM_END=$(now_ms)
echo "    warm batch wall time = $((WARM_END - WARM_START))ms"

echo "==> OpenAI-compatible route sanity"
curl -s "http://localhost:${PORT}/v1/embeddings" \
  -H 'content-type: application/json' \
  -d '{"input":"hello","model":"qwen3-embed","encoding_format":"float"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('    /v1/embeddings ok, dim', len(d['data'][0]['embedding']))"
echo "==> smoke complete"
