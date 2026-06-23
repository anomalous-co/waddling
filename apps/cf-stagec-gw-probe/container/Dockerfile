# Stage D gateway probe — the waddling gateway as a CF Container image.
# (build-bust: step5 reapply route)
#
# Base = docker.io/cloudflare/sandbox:<pin> (REQUIRED, not cosmetic): the Sandbox
# SDK ships an in-container process-server that the GatewayDO's startProcess() /
# containerFetch() calls talk to over the container's control port. A bare node
# image could NOT be driven by a Sandbox subclass. Same pin as the proven Stage 0
# gate + hop probe so there is no divergence from the proven egress image.
#
# Unlike the hop probe, this image runs a REAL in-container node process: the
# gateway (DuckDB + quack_serve + birdshot) plus a :8080 forwarder. So we add the
# DuckDB native bindings, tsx, and the birdshot extension binary.
#
# Must build for linux/amd64 (the CF container target). The birdshot binary is
# arch-specific: we fetch the linux_amd64 build from the R2 CDN (mirrors
# scripts/waddling-demo/Dockerfile.gateway:60, which bakes the platform-matched
# birdshot binary). The host-local birdshot/build-linux/ binary is arm64 and
# would NOT LOAD here, so we deliberately do NOT copy it.
#
#   docker build --platform=linux/amd64 -t cf-stagec-gw-probe ../container
FROM docker.io/cloudflare/sandbox:0.12.1

WORKDIR /app

# ── birdshot extension binary (linux_amd64) ──────────────────────────────────
# Fetched from the waddling R2 CDN at build time (the canonical native layout:
# v<ver>/<platform>/birdshot.duckdb_extension.gz — see infra/r2/setup-r2.sh).
# DEPLOY-TIME DEPENDENCY: this RUN needs network + DNS for ext.getwaddling.com.
# It resolves on Cloudflare's build infra; it does NOT resolve from the local
# dev sandbox (NXDOMAIN), so a LOCAL `wrangler deploy --dry-run` image build
# stops here. The conductor's real deploy resolves it. See worker/README.md.
# Baked from the build context (NOT fetched). The canonical CDN
# (ext.getwaddling.com) and the CI bucket (waddling-ext) are not live in this
# account, so we COPY the platform-matched linux_amd64 .gz staged next to this
# Dockerfile and gunzip it in-image — no network/DNS dependency at build time.
# Verified x86-64 ELF. Replace with the CDN/R2 fetch once the CI publish is live.
COPY birdshot/birdshot.duckdb_extension.gz /opt/birdshot/birdshot.duckdb_extension.gz
RUN gunzip -f /opt/birdshot/birdshot.duckdb_extension.gz \
 && test -s /opt/birdshot/birdshot.duckdb_extension
ENV BIRDSHOT_EXTENSION_PATH=/opt/birdshot/birdshot.duckdb_extension

# ── gateway code + native deps ───────────────────────────────────────────────
# Copy the REAL gateway boot code (packages/gateway/src → gateway/gateway-src/)
# so the entrypoint imports it rather than forking it. control-schema is consumed
# type-only by duck.ts; tsx erases the import at runtime, so we don't need it.
WORKDIR /opt/gateway
COPY gateway/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# ── pre-bake DuckDB extensions (cold-start optimization) ─────────────────────
# Cold boot was dominated by the gateway downloading quack/httpfs/ducklake/postgres/fts
# from the network on every start. Bake them into a fixed extension_directory at BUILD
# time; bootDuckRuntime opens DuckDB with the SAME DUCKDB_EXTENSION_DIR, so its INSTALLs
# are local cache hits (no network). Needs network+DNS to the DuckDB extension repos at
# build (resolves in local docker + CF build infra). Uses the just-installed node-api so
# the cached version/platform path matches the runtime.
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb-extensions
COPY gateway/prebake-extensions.mjs ./prebake-extensions.mjs
RUN node prebake-extensions.mjs

COPY gateway/gateway-src/ ./gateway-src/
COPY gateway/entrypoint.mjs ./entrypoint.mjs

# ── pre-compile entrypoint + gateway-src to plain JS (cold-start optimization) ───
# Boot was `node --import tsx entrypoint.mjs`, which transpiled the TypeScript gateway-src
# (duck.ts) on EVERY cold start. Bundle it once here with esbuild into entrypoint.js, leaving
# node_modules (the native @duckdb/node-api bindings) external, so the BOOT_CMD runs plain
# `node entrypoint.js` with zero runtime transpilation. esbuild is installed transiently (not
# saved, then removed) so it doesn't bloat the runtime image, and tsx is dropped from deps.
RUN npm install --no-save --no-audit --no-fund esbuild \
 && node_modules/.bin/esbuild entrypoint.mjs --bundle --platform=node --format=esm --packages=external --outfile=entrypoint.js \
 && rm -rf node_modules/esbuild node_modules/@esbuild \
 && test -s entrypoint.js

ENV GW_STATE_DIR=/var/lib/waddling
ENV QUACK_PORT=9500
ENV FORWARDER_PORT=8080
RUN mkdir -p /var/lib/waddling

# Deployed probe: DO NOT set a CMD. The base image's ENTRYPOINT is the Sandbox SDK
# process-server — it must run with NO extra args so the server stays up and the
# GatewayDO's startProcess()/containerFetch() can reach it. The gateway boot is
# launched BY the DO via startProcess('node --import tsx /opt/gateway/entrypoint.mjs'),
# NOT as the container CMD.
