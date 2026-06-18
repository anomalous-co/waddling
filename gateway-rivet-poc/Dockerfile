# Dockerfile for the waddling gateway Rivet actor.
#
# Build context: repo root (one level above gateway-rivet-poc/).
# Build with:
#   docker build -f gateway-rivet-poc/Dockerfile -t waddling-gateway-actor .
#
# MUST use a glibc image (node:24, NOT alpine/musl) — @duckdb/node-api and
# birdshot are compiled against glibc. Alpine musl will segfault or refuse to
# load the native addon.
#
# The birdshot Linux amd64 extension is expected at:
#   birdshot/build-linux/birdshot.duckdb_extension
# CI downloads it from R2 before running `docker build`. See infra/gcp/deploy-actor.sh.

FROM node:24-slim AS base
RUN npm install -g pnpm@10.24.0

# ── workspace deps stage ──────────────────────────────────────────────────────
# Install packages/gateway (which owns @duckdb/node-api) and packages/control-schema
# (needed as a workspace dep of gateway). The gateway-rivet-poc references
# packages/gateway via a relative TS import, so gateway's node_modules must be present.
FROM base AS ws-deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY .npmrc* ./
COPY packages/control-schema/package.json ./packages/control-schema/
COPY packages/gateway/package.json            ./packages/gateway/

# --filter @waddling/gateway... installs gateway + its workspace deps only.
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter @waddling/gateway...

# ── actor deps stage ──────────────────────────────────────────────────────────
# gateway-rivet-poc is NOT in the pnpm workspace (own package.json, npm).
FROM base AS actor-deps
WORKDIR /app/gateway-rivet-poc

COPY gateway-rivet-poc/package.json ./
# Install rivetkit, jose + dev deps (tsx needed to run TS directly).
RUN npm install

# ── runtime image ─────────────────────────────────────────────────────────────
FROM node:24-slim AS runner
WORKDIR /app

# Workspace node_modules (contains @duckdb/node-api native addon)
COPY --from=ws-deps /app/node_modules          ./node_modules
COPY --from=ws-deps /app/package.json          ./package.json
COPY --from=ws-deps /app/pnpm-workspace.yaml   ./pnpm-workspace.yaml

# packages/gateway and packages/control-schema source (tsx transpiles at runtime)
COPY packages/gateway/src      ./packages/gateway/src
COPY packages/gateway/package.json ./packages/gateway/package.json
COPY packages/control-schema/  ./packages/control-schema/

# gateway-rivet-poc node_modules + source
COPY --from=actor-deps /app/gateway-rivet-poc/node_modules ./gateway-rivet-poc/node_modules
COPY gateway-rivet-poc/src/        ./gateway-rivet-poc/src/
COPY gateway-rivet-poc/tsconfig.json ./gateway-rivet-poc/

# birdshot Linux extension for the target platform (amd64 or arm64).
# deploy-actor.sh stages the right binary at birdshot/build-linux/ before build.
# CI downloads from R2, or pass --build-arg BIRDSHOT_PATH to override.
ARG BIRDSHOT_PATH=birdshot/build-linux/birdshot.duckdb_extension
COPY ${BIRDSHOT_PATH} /birdshot.duckdb_extension

ENV BIRDSHOT_EXTENSION_PATH=/birdshot.duckdb_extension
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

WORKDIR /app/gateway-rivet-poc
CMD ["node_modules/.bin/tsx", "src/registry.ts"]
