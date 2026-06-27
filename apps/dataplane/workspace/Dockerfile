# Stage C workspace probe — the workspace-sidecar container image (Model B).
#
# Base = docker.io/cloudflare/sandbox:<pin> (REQUIRED, not cosmetic): the Sandbox
# SDK ships an in-container process-server that the WorkspaceSandbox DO's
# startProcess() / containerFetch() calls talk to over the container's control port.
# A bare node image could NOT be driven by a Sandbox subclass. Same pin as the proven
# Stage 0 gate + hop probe so there is no divergence from the proven egress image.
#
# Unlike the hop probe, this image runs a REAL in-container node process: the
# workspace sidecar (DuckDB + quack + httpfs). So we add the DuckDB native bindings.
# NO birdshot — birdshot is gateway-side (this is the agent's private workspace).
#
# Must build for linux/amd64 (the CF container target). The @duckdb/node-api native
# addon resolves the linux_amd64 prebuilt at install.
#
#   docker build --platform=linux/amd64 -t waddling-workspace .
FROM docker.io/cloudflare/sandbox:0.12.1

# ── workspace sidecar + native deps ──────────────────────────────────────────
WORKDIR /opt/workspace
COPY sidecar/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY sidecar/workspace-sidecar.mjs ./workspace-sidecar.mjs

# Pre-bake the extension cache so the sidecar's INSTALL quack/httpfs hit a local cache
# (no extension repo egress at runtime — disabled_filesystems blocks it anyway). This
# runs a throwaway node one-liner to populate ~/.duckdb. HOME is /root here; the
# sidecar runs as the same user so the cache is shared.
RUN node -e "const {DuckDBInstance}=require('@duckdb/node-api'); (async()=>{const i=await DuckDBInstance.create(':memory:');const c=await i.connect();await c.run('INSTALL quack; INSTALL httpfs;');console.log('ext cache primed');})().catch(e=>{console.error(e);process.exit(1)})"

# One sidecar per container → fixed port + db path baked in (no freePort needed). The
# DB_FILE lives on the container's writable layer; the encrypted bytes are restored
# from / persisted to R2 by the sidecar over presigned URLs.
ENV SIDECAR_PORT=8080
ENV DB_FILE=/var/lib/waddling/workspace.duckdb
RUN mkdir -p /var/lib/waddling

# TLS trust for the container→R2 leg. With interceptHttps=true the SDK MITMs the
# container's outbound HTTPS with a per-instance EPHEMERAL CA that the SYSTEM trust
# store carries, but Node's undici `fetch` verifies against Node's OWN bundled CA
# list and ignores the system store by default — so the sidecar's plain-fetch to the
# presigned R2 URL would fail cert verification. The DO launches the sidecar with
# `node --use-system-ca` (Node 22+, present here: v22.x) which points undici at the
# system store that holds the ephemeral CA. We deliberately do NOT set this as a global
# NODE_OPTIONS ENV (that would also apply to the base image's own JS/TS process-server
# pools) — it is passed only on the sidecar invocation. See worker README for the
# deploy-time caveat (this TLS leg can only be verified on the deployed run).

# Deployed probe: DO NOT set a CMD. The base image's ENTRYPOINT is the Sandbox SDK
# process-server — it must run with NO extra args so the server stays up and the
# WorkspaceSandbox DO's startProcess()/containerFetch() can reach it. The sidecar is
# launched BY the DO via startProcess('node /opt/workspace/workspace-sidecar.mjs'),
# NOT as the container CMD.
