# Stage C lynchpin probe #1 — the workspace-sidecar container image.
#
# Base = docker.io/cloudflare/sandbox:<pin>, REQUIRED (not cosmetic): the Sandbox
# SDK ships an in-container process-server that the Worker's exec()/containerFetch
# calls talk to over the container's control port. A bare node image could NOT be
# driven by a Sandbox subclass. Same pin as the Stage 0 gate so there is no
# divergence between the proven egress image and this hop probe.
#
# This probe makes ONE outbound HTTPS request via `curl` (already present in the
# sandbox base) — it does NOT run any in-container node script and does NOT need
# @duckdb/node-api. We therefore omit the DuckDB dependency layer entirely; the
# egress mechanism under test (allowedHosts + interceptHttps + the static outbound
# handler routing to a DO binding) is protocol-agnostic and fully exercised by a
# plain HTTPS GET.
#
# Must run on linux/amd64 (the CF container target). Build with:
#   docker build --platform=linux/amd64 -t cf-stagec-hop-probe .
FROM docker.io/cloudflare/sandbox:0.12.1

WORKDIR /app

# Deployed probe: DO NOT set a CMD. The base image's ENTRYPOINT is the Sandbox SDK
# process-server (/container-server/sandbox) with a null CMD — it must run with NO
# extra args so the server stays up and the Worker's exec()/containerFetch can reach
# it. Setting CMD here makes the server run that finite script and exit → the
# instance crash-loops and every exec returns "Container is starting".
