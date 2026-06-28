# control-api as a plain Node image for Cloud Run (ported off workerd). linux/amd64.
# esbuild bundles src/server.ts (the Node entry) with --packages=external, so runtime deps
# stay in node_modules. A module-level pg.Pool connects to Cloud SQL over the Cloud Run unix
# socket (--add-cloudsql-instances); DATABASE_URL comes from Secret Manager.
FROM node:24-slim
WORKDIR /app

# Standalone install — control-api's package.json has no workspace:* deps, so it images cleanly.
COPY package.json ./package.json
RUN npm install --no-audit --no-fund --legacy-peer-deps

# Source + build the Node bundle.
COPY . .
RUN npx esbuild src/server.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/server.js \
 && test -s dist/server.js

ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
