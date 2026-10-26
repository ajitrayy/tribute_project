# Deployment

The app is one Node.js codebase with two roles:

* **web**: the dashboard and JSON API (`src/main.js web`)
* **worker**: the scheduled monitor plus the job queue for download → extract →
  render (`src/main.js worker`)

`src/main.js all` runs both in one process, which is fine for a single small server.
State lives in `DATA_DIR`: the SQLite database (`app.db`, WAL mode), source images,
generated PNGs and the logo. Back that directory up, and run **one** worker.

## Requirements

* Node.js **22.13+** (uses the built-in `node:sqlite`)
* Chromium for rendering, installed by Playwright (the Docker image already has it)
* No outbound access is needed for the free workflow (OCR files are served by the app).
  Automatic monitoring additionally needs `graph.facebook.com` and `*.fbcdn.net`.

## Option A – Docker Compose (recommended)

```bash
cp .env.example .env        # set ADMIN_PASSWORD; FB_* only for automatic monitoring
docker compose up -d --build
docker compose exec worker npm run fb:check -- https://www.facebook.com/YourPage
```

The dashboard listens on port 3000. The image sets `HOST=0.0.0.0` so the published port
works inside the container. Outside Docker the default is `127.0.0.1` (local only). Put it behind HTTPS (Caddy, nginx, a cloud load
balancer). The dashboard uses HTTP Basic auth, which is only safe over TLS.

`./templates` is mounted read-only, so you can add or adjust the official template
without rebuilding. Restart both services after changing a template.

## Option B – a VM without Docker

```bash
git clone <repo> && cd <repo>
npm ci --omit=dev
npx playwright install --with-deps chromium
cp .env.example .env && $EDITOR .env
NODE_ENV=production npm start          # or run `npm run web` and `npm run worker` under systemd
# listens on 127.0.0.1:3000 - put a reverse proxy (Caddy/nginx) with HTTPS in front,
# or set HOST=0.0.0.0 only if the server must accept connections directly
```

Example systemd unit for the combined process:

```ini
[Unit]
Description=IBN7 poster generator
After=network-online.target

[Service]
WorkingDirectory=/opt/ibn7-poster
EnvironmentFile=/opt/ibn7-poster/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/main.js all
Restart=always
User=ibn7

[Install]
WantedBy=multi-user.target
```

## Platform notes

* The worker is long-running. Serverless platforms that freeze idle processes (for
  example Vercel functions) are not a fit for it. Use a VM, a container service (Fly.io,
  Render, Railway, ECS, Cloud Run with min-instances=1 and CPU always allocated) or
  Kubernetes with a persistent volume.
* SQLite needs a local disk volume. Do not put `DATA_DIR` on NFS/SMB.

## After deploying

1. Open the dashboard and sign in with `ADMIN_USER` / `ADMIN_PASSWORD`.
2. *Branding & template*: upload the official logo, install and select the official
   template (docs/TEMPLATE.md).
3. Run `npm run fb:check -- <urls>` on the server. Fix anything it reports
   (docs/FACEBOOK_ACCESS.md).
4. *Facebook Pages*: add the Page URLs. Each should show access `ok`.
5. Set the interval, leave monitoring running, and confirm that a newly published poster
   shows up within one interval. Until this end-to-end check passes on your Pages,
   treat monitoring as unverified.

## Operations

* **Logs**: the dashboard *Logs* tab shows monitor, worker and editor events, also
  written to stdout. Tokens are redacted.
* **Retries**: failed jobs retry with exponential backoff (`JOB_BACKOFF_BASE_SEC` ×
  2ⁿ, up to `JOB_MAX_ATTEMPTS`). Jobs left `running` by a crashed worker are requeued
  after `JOB_STALE_LOCK_MIN` minutes.
* **Graph API versions** are retired about two years after release. Bump
  `FB_GRAPH_VERSION` and re-run `fb:check` when Meta announces a deprecation.
* **Token expiry**: system-user tokens do not expire, but they stop working if the
  system user loses access to a Page. Such Pages show `token_error` or `no_access`.
