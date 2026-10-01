# Build the static site, then serve it with a tiny Node server (no runtime dependencies).
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN node scripts/build.mjs

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY scripts/serve.mjs ./scripts/serve.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "scripts/serve.mjs", "--dist"]
