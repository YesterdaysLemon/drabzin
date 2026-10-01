<!-- al-stack:project:start -->
## Al-stack project

Project: drabzin-vectorizer. Profile: web. Status: experimental.

Drabzin Vectorizer: turns images of door and gate designs into DXF cut paths for lasers and CNC routers, entirely in the browser (static site)

`al-stack.toml` records this project's setup and dependencies. Work from the checkout selected for the task; other branches/worktrees are optional history. Use `al-stack register .` once when starting work here. Local registration does not change the project's lifecycle.

Project commands:
- dev: `npm run dev`
- build: `npm run build`
- test: `npm test`
- preview: `npm run preview`

Edit project guidance outside this managed section. Use `al-stack configure` for its fields and `al-stack check .` for setup checks. Run the actual project checks for behavioral validation.
<!-- al-stack:project:end -->

# Drabzin Vectorizer

Turns a picture of a door or gate design into a DXF file for laser and CNC cutting. Built
for a metal shop: the people using it are designers who know conversational English, so
every word in the UI is plain, short and literal (see "Copy" below). README.md covers the
modes, workflow, engine layout and accuracy; docs/requirements.md the shop's answers.

## Copy

- Short sentences. Common words. Say what to do ("Move it left"), not how the engine works.
- No jargon in labels: "Colour cut-off", not "threshold"; "Loose pieces", not "islands";
  "Bar width", not "strap width"; counts use the right singular/plural (`count()` in app.js).
- Numbers the user sees must match what they see now (counts update after deletions).

## Deployment

- Live at https://drabzin.alirezaafshan.com (Deploy Manager app `drabzin`, Caddy -> loopback
  3300, candidate 3301, container port 8080, `/healthz` reports the build SHA). Cloudflare
  proxies the hostname (A record to the VPS).
- Pushes to `main` run `.github/workflows/deploy.yml`: `npm test` (fails if accuracy drops),
  build, a production-server check, then the signed Deploy Manager webhook and a live SHA check.
- The image (`Dockerfile`) builds `dist/` and serves it with `scripts/serve.mjs --dist`: a tiny
  Node server with no dependencies, a strict Content Security Policy (the page can only talk
  to its own site, which backs the "never uploaded" promise) and ETag caching.

## Acceptance

- `npm test` and `npm run build` pass; `npm run preview` serves the app with no console errors.
- Live: `/healthz` reports the deployed commit; the page loads and an image traces.
