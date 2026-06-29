# Public quack router image (plain Node, no native deps). linux/amd64 for Cloud Run.
FROM node:24-slim
WORKDIR /opt/router
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY index.mjs ./index.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.mjs"]
