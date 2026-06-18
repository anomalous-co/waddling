# Workspace-sidecar container image for the Cloudflare data plane.
#
# Base = docker.io/cloudflare/sandbox:<pin>. This is REQUIRED, not cosmetic: the
# Sandbox SDK ships an in-container process-server that the Worker's
# containerFetch/exec/startProcess calls talk to over the container's control
# port. A bare node:20-bookworm image would build and run our sidecar fine for
# the offline probes (#2/#3/#4), but it could NOT be driven by a Sandbox subclass
# (probe #1) — so we standardize on the sandbox base for ALL probes to avoid
# image divergence between the offline checks and the deployed gate. The base is
# Debian/glibc with Node.js 20 preinstalled.
#
# Must run on linux/amd64 (the CF container target AND the arch of the
# @duckdb/node-bindings-linux-x64 glibc prebuilt). Build with:
#   docker build --platform=linux/amd64 -t cf-stage0-probe .
FROM docker.io/cloudflare/sandbox:0.12.1

WORKDIR /app

# Install ONLY @duckdb/node-api. On linux/amd64 glibc, detect-libc resolves to
# linux-x64 and npm pulls the @duckdb/node-bindings-linux-x64 prebuilt addon
# (DuckDB v1.5.3-r.3) — no from-source compile. We copy package.json first so the
# dependency layer caches independently of the probe scripts.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Probe scripts + the sidecar entrypoint (probe-local copy of workspace-sidecar.ts).
COPY sidecar.mjs probe.mjs birdshot-check.mjs ./

# Deployed gate (probe #1): DO NOT set a CMD. The base image's ENTRYPOINT is the
# Sandbox SDK process-server (/container-server/sandbox) and its CMD is null — it
# must run with NO extra args so the server stays up and the Worker's exec() /
# containerFetch can reach it. Setting CMD here (e.g. ["node","probe.mjs"]) makes
# the server run that finite script and exit → the instance crash-loops and every
# exec returns "Container is starting".
#
# The offline probes (#2/#3/#4) do NOT depend on this image's CMD — run-local-probes.sh
# overrides the entrypoint explicitly, e.g.:
#   docker run --rm --entrypoint node <img> probe.mjs
#   docker run --rm --entrypoint node <img> birdshot-check.mjs
