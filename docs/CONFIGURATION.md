# Configuring API keys and credentials securely

Every secret is read from **environment variables on the server**. None of them is
ever sent to the browser, written to the database, or printed in logs (tokens in
error messages are replaced with `[redacted]`). The dashboard shows only whether
each one is set (*Facebook Pages* tab).

## What each key is for

| Variable | Needed for | Where to get it |
|---|---|---|
| `ADMIN_PASSWORD` (+ `ADMIN_USER`) | Signing in to the dashboard. **Required in production.** | Choose a long random password (`openssl rand -base64 24`). |
| `ANTHROPIC_API_KEY` | Automatic Hindi text extraction from posters. Without it, editors type the text. | console.anthropic.com → API keys. Create a key used only by this app. |
| `FB_APP_ID`, `FB_APP_SECRET` | Facebook Graph API. The secret signs every call (`appsecret_proof`). | developers.facebook.com → your app → Settings → Basic. |
| `FB_USER_ACCESS_TOKEN` | Reading Pages your business manages (or that granted you access). | Business Settings → System users → Generate token (see docs/FACEBOOK_ACCESS.md). |
| `FB_PAGE_ACCESS_TOKENS` | Optional: explicit Page tokens, as JSON `{"<page id or username>":"<token>"}`. | Graph API Explorer or `/me/accounts`. |
| `FB_PPCA_APPROVED` | Set to `true` only if Meta approved Page Public Content Access for your app. | App Review. |

## Setting them

**Docker Compose** (recommended). Put them in `.env` next to `docker-compose.yml`:

```bash
cp .env.example .env
chmod 600 .env                 # readable only by the owner
$EDITOR .env
docker compose up -d           # both services read .env via env_file
```

**systemd**: put them in an `EnvironmentFile=` owned by root with mode `600`
(see docs/DEPLOYMENT.md).

**Cloud platforms** (Render, Railway, Fly.io, ECS, Cloud Run…): add them in the
platform's *secrets / environment variables* screen, not in the repository. Most also
offer a secret manager (AWS Secrets Manager, GCP Secret Manager); inject secrets from
it as environment variables.

## Rules

* **Never commit secrets.** `.env` is in `.gitignore`. If a secret ever lands in git
  history, rotate it. Deleting the commit is not enough.
* **Never paste secrets into the dashboard, chat, tickets or screenshots.**
  `npm run fb:check` prints token *metadata* (type, scopes, expiry), never the token.
* **Use a system-user token** for Facebook, not a personal user token. It does not
  expire with a person's session, and it can be limited to just the Pages and
  permissions this app needs (`pages_show_list`, `pages_read_engagement`).
* **One key per app.** Give this app its own Anthropic key, so you can see its spend and
  revoke it independently. Set a spend limit on that workspace in the Anthropic Console.
* **Rotate** after staff changes or any suspected leak: create the new key, update the
  environment, restart, then delete the old key.
* **Serve the dashboard over HTTPS only.** Basic auth sends the password with every
  request.

## Checking the configuration

```bash
npm run fb:check -- https://www.facebook.com/YourPage   # Facebook token + Page access
npm run extract:check -- path/to/poster.jpg             # Anthropic key + Hindi extraction
```

Both commands run against the real services, so they are the way to confirm a key
works. They read the same environment as the app. With Docker, run them inside the
container: `docker compose exec worker npm run fb:check -- …`.
