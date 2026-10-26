# IBN7 Bharat Poster Generator

Watches configured Facebook news Pages for new image posters, reads the Hindi text off
each poster, and rebuilds it in the IBN7 Bharat template with the official logo. Every
poster goes to a review dashboard. Nothing is published to Facebook.

author : ajit baabaaaji

## Current status

| Part | State |
|---|---|
| Dashboard, history, edit / regenerate / approve / download | Working, covered by tests |
| Job queue: retries, backoff, crash recovery, duplicate detection | Working, covered by tests |
| Hindi rendering (Chromium + embedded Noto Sans Devanagari), undistorted logo | Working, covered by tests |
| Facebook monitoring (Graph API) | Implemented and tested against a **simulated** Graph API only. **Not yet verified against a real Page.** No Page URLs or credentials have been supplied, and the build environment could not reach Facebook. Run `npm run fb:check` once credentials are set. |
| Automatic text extraction (Claude vision) | Implemented. Not exercised in tests (no API key in the build environment). Without a key the app falls back to manual text entry. |
| IBN7 Bharat template | **Not installed.** Only a neutral placeholder layout ships. Its output is stamped DRAFT and cannot be approved until the official template is built from your reference posters (docs/TEMPLATE.md). |

Read **[docs/FACEBOOK_ACCESS.md](docs/FACEBOOK_ACCESS.md)** first. It explains which
Pages the Graph API can read (Pages you manage, or Pages that grant your business
access), why public Pages owned by other outlets generally cannot be read, and the
supported manual-import fallback.

## How it works

```
 Facebook Graph API ──poll every N min──► monitor ──new photo posts──► jobs (SQLite)
                                                                        │
     dashboard ◄── review / edit / approve / download ◄── render ◄── extract ◄── download + dedupe
```

1. **Pages**: add Page URLs in the dashboard. Each is resolved and its access is checked
   right away.
2. **Monitor** (worker): at the configured interval (pause/resume and "check now" in the
   header) it reads each Page's new posts. Photo and album posts are queued. Text, link
   and video posts are recorded as skipped. Each post+image is processed once (unique
   key per post and image).
3. **Download & dedupe**: stores the full-size source image and compares a perceptual
   hash, so the same poster reposted, or posted on several monitored Pages, is flagged as
   a duplicate.
4. **Extract**: Claude vision transcribes the Hindi text verbatim into structured fields
   (strap, headline, sub-headline, lines, location, date). It lists the names, places and
   numbers separately, and separates the source outlet's branding so it is not copied.
5. **Fact check**: compares the poster fields with the transcription. It flags numbers
   that changed or appeared, names or places that were dropped, and source branding that
   leaked in.
6. **Render**: fills the active template and renders a PNG in headless Chromium.
7. **Review**: preview the source and the new poster side by side, edit the text
   (re-renders), regenerate (re-reads the source), add a photo, approve, and download
   the PNG. History keeps every version and job attempt.

Pages the API cannot read can go through **Manual import**: upload the poster image and
its link, and the rest of the pipeline is the same.

## Quick start (development)

```bash
npm install
cp .env.example .env              # optional: ANTHROPIC_API_KEY, FB_* credentials
npm start                         # dashboard on http://localhost:3000, worker in the same process
npm test
```

Deployment: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Building the official
template: **[docs/TEMPLATE.md](docs/TEMPLATE.md)**.

## Layout

```
src/
  main.js               entry point: web | worker | all
  server.js             dashboard API (HTTP Basic auth)
  worker.js             scheduler loop + job runner
  facebook/             URL parsing, Graph API client, monitor
  pipeline/             extract (Claude), facts, template, render (Chromium), process
  jobs.js posts.js db.js logger.js imagehash.js
  cli/fb-check.js       live access check against real Pages
public/                 dashboard (no build step)
templates/placeholder/  neutral stand-in template (replace, see docs/TEMPLATE.md)
test/                   node:test suites
```
