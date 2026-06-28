# waddling gateway as a plain GCP Cloud Run image (DuckDB + quack_serve + birdshot).
# quack_serve is the product surface: external agents `ATTACH 'quack:<host>:443'` to dial in
# from their own DuckDB instances; the in-process forwarder proxies the quack wire protocol to
# the loopback listener and co-locates the birdshot control channel (/ctrl/*) + governed write
# path (/governed-load). Must build for linux/amd64 (birdshot binary arch + Cloud Run target).
#
#   docker build --platform=linux/amd64 -t waddling-gateway-cloudrun .
FROM node:24-slim

# CA certs: node:*-slim ships without the system CA bundle, so DuckDB's httpfs cannot verify
# TLS to storage.googleapis.com — every GCS parquet write/read fails with "Problem with the SSL
# CA cert (path? access rights?)". (Cloud SQL mTLS works regardless: the postgres extension is
# handed explicit PEMs.) Install the bundle so the lake's GCS data path works over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && update-ca-certificates

WORKDIR /opt/gateway

# ── birdshot extension binary (linux_amd64) ──────────────────────────────────
# Staged next to this Dockerfile (birdshot/birdshot.duckdb_extension.gz, the same
# platform-matched .gz the CF gateway bakes) and gunzipped in-image — no network/DNS
# dependency on ext.getwaddling.com at build time. Verified x86-64 ELF.
COPY birdshot/birdshot.duckdb_extension.gz /opt/birdshot/birdshot.duckdb_extension.gz
RUN gunzip -f /opt/birdshot/birdshot.duckdb_extension.gz \
 && test -s /opt/birdshot/birdshot.duckdb_extension
ENV BIRDSHOT_EXTENSION_PATH=/opt/birdshot/birdshot.duckdb_extension

# ── native deps (@duckdb/node-api) ───────────────────────────────────────────
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# ── pre-bake DuckDB extensions (cold-start: quack/ducklake/postgres/httpfs as local cache hits) ──
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb-extensions
COPY prebake-extensions.mjs ./prebake-extensions.mjs
RUN node prebake-extensions.mjs || echo "[build] prebake skipped (extensions install at runtime)"

# ── code + esbuild bundle (entrypoint.mjs + the TS gateway-src → plain entrypoint.js) ──
COPY gateway-src/ ./gateway-src/
COPY entrypoint.mjs ./entrypoint.mjs
RUN npm install --no-save --no-audit --no-fund esbuild \
 && node_modules/.bin/esbuild entrypoint.mjs --bundle --platform=node --format=esm --packages=external --outfile=entrypoint.js \
 && rm -rf node_modules/esbuild node_modules/@esbuild \
 && test -s entrypoint.js

ENV GW_STATE_DIR=/var/lib/waddling
ENV PORT=8080
RUN mkdir -p /var/lib/waddling
EXPOSE 8080

CMD ["node", "entrypoint.js"]
