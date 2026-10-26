# Configuration and secrets

## The free workflow needs no API keys

Uploading a poster, reading its Hindi text, editing it and downloading the IBN7
Bharat PNG uses only:

* **Tesseract.js** (Apache-2.0) with its **Hindi and English language data** (MIT),
  installed by `npm install` and served by the app itself. OCR runs in the editor's
  browser. Nothing is sent to an outside service, and there is nothing to pay for.
* Headless Chromium (Playwright) on the server for rendering the PNG.

By default the app listens on `127.0.0.1`, so only the computer it runs on can open
it. Still, set a dashboard password, in a `.env` file in the project folder (git-ignored):

```env
ADMIN_USER=admin
ADMIN_PASSWORD=<long random password>     # required when NODE_ENV=production
```

Generate one with `openssl rand -base64 24`.

## Optional settings

| Variable | Needed for | Notes |
|---|---|---|
| `FB_APP_ID`, `FB_APP_SECRET`, `FB_USER_ACCESS_TOKEN`, `FB_PAGE_ACCESS_TOKENS`, `FB_PPCA_APPROVED` | **Automatic Facebook monitoring only.** Manual import never uses them. | Without them the dashboard shows *"Facebook monitoring: not configured – manual import only"*. See docs/FACEBOOK_ACCESS.md for how to obtain them and what they can read. |
| `EXTRACTION_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | Optional **paid** vision-model extraction. **Not part of the free workflow.** | Off unless `EXTRACTION_PROVIDER=anthropic` is set explicitly. A key on its own does nothing. Leave both unset for the free workflow. |
| `HOST` | Which network address the dashboard listens on | Default `127.0.0.1`: only this computer can open it. `0.0.0.0`: other devices on the network can too (the Docker image and docker-compose set this). Only change it together with a strong `ADMIN_PASSWORD` and, beyond your own network, HTTPS. |
| `PORT`, `DATA_DIR`, worker settings | Server tuning | See `.env.example`. |

## Keeping any secrets safe

Secrets (dashboard password, Facebook tokens) are read only from **environment
variables on the server**. They are never sent to the browser, stored in the database or
printed in logs (tokens in error messages are replaced with `[redacted]`).

* Put them in `.env` next to the app (`cp .env.example .env && chmod 600 .env`), in a
  systemd `EnvironmentFile=` with mode `600`, or in your hosting platform's secrets
  screen.
* **Never commit `.env`** (it is in `.gitignore`), and never paste secrets into the
  dashboard, chat, tickets or screenshots. If one leaks, rotate it.
* For Facebook, use a **system-user token** limited to `pages_show_list` and
  `pages_read_engagement` on the Pages you monitor.
* Serve the dashboard over **HTTPS only**. Basic auth sends the password with every
  request.

## Checking the setup

```bash
npm run ocr:check -- path/to/poster.jpg                 # free Hindi OCR from the terminal
npm run fb:check -- https://www.facebook.com/YourPage   # only if Facebook monitoring is configured
```
