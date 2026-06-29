# The gateway provisioner — a tiny Node service that deploys per-datalake Cloud Run gateways.
FROM node:24-slim
WORKDIR /app
COPY package.json ./package.json
RUN npm install --no-audit --no-fund --omit=dev
COPY index.mjs ./index.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.mjs"]
