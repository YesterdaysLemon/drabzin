# Build the static site, then serve it with a tiny Node server (no runtime dependencies).
FROM node:22-alpine AS build
WORKDIR /app
# Click-to-select runs in the browser from this site's own files. Fetch what it needs before the
# source is copied, so these two layers are cached until the pins change: the onnxruntime-web
# library and its WebAssembly (pinned in package-lock.json), and the model weights (about 40 MB,
# pinned by revision and SHA-256 in web/segment/models.json; the build fails if one is wrong).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY scripts/fetch-models.mjs ./scripts/fetch-models.mjs
COPY web/segment/models.json ./web/segment/models.json
RUN node scripts/fetch-models.mjs
COPY . .
RUN node scripts/build.mjs --require-models

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY scripts/serve.mjs ./scripts/serve.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "scripts/serve.mjs", "--dist"]
