# Dockerfile.app — multi-stage build for the waddling Next.js control-plane app.
# Build context: repo root (../../ relative to scripts/waddling-demo/)

FROM node:20-slim AS base
RUN npm install -g pnpm@10.24.0

# ── deps stage: install all workspace dependencies ─────────────────────────────
FROM base AS deps
WORKDIR /app

# Copy workspace manifests and lockfile first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY .npmrc* ./

# Copy only the package manifests for the packages we need
COPY packages/control-schema/package.json ./packages/control-schema/
COPY packages/gateway/package.json ./packages/gateway/
COPY packages/mcp-external/package.json ./packages/mcp-external/
COPY packages/mcp-internal/package.json ./packages/mcp-internal/
COPY apps/waddling/package.json ./apps/waddling/

# Install all dependencies (workspace-aware, frozen lockfile)
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── source stage: copy source and build ───────────────────────────────────────
FROM deps AS builder
WORKDIR /app

# Copy source for packages that app depends on
COPY packages/control-schema/ ./packages/control-schema/
# gateway package provides @duckdb/node-api used by seed.ts
COPY packages/gateway/ ./packages/gateway/

# Copy the app source
COPY apps/waddling/ ./apps/waddling/

ARG SKIP_ENV_VALIDATION=1
ENV SKIP_ENV_VALIDATION=${SKIP_ENV_VALIDATION}
ENV NODE_ENV=production

# Also copy the seed script (used by the seed service)
COPY scripts/waddling-demo/seed.ts ./scripts/waddling-demo/seed.ts

# Build the Next.js app
RUN pnpm --filter @waddling/app build

# ── runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

RUN npm install -g pnpm@10.24.0 tsx

ENV NODE_ENV=production
ENV PORT=3100

# Copy the built Next.js app and its deps
COPY --from=builder /app/apps/waddling/.next ./apps/waddling/.next
COPY --from=builder /app/apps/waddling/public ./apps/waddling/public
COPY --from=builder /app/apps/waddling/package.json ./apps/waddling/package.json
COPY --from=builder /app/apps/waddling/next.config.mjs ./apps/waddling/next.config.mjs

# Copy all workspace deps (node_modules has @duckdb/node-api from gateway pkg,
# needed by seed.ts which runs inside this image via the seed compose service)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Copy seed script
COPY --from=builder /app/scripts/waddling-demo/seed.ts ./scripts/waddling-demo/seed.ts

EXPOSE 3100

# Default CMD: start the Next.js app (cd to app dir first; next start needs CWD=app)
# WORKDIR /app (workspace root) is preserved so the seed service can resolve
# scripts/waddling-demo/seed.ts when compose overrides CMD.
CMD ["sh", "-c", "cd /app/apps/waddling && exec node ../../node_modules/.bin/next start"]
