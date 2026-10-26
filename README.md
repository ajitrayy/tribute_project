# IBN7 Bharat Poster Generator

Turns a Hindi news poster from Facebook into a new poster in the IBN7 Bharat template
with the official logo, using a **free workflow**: upload the poster image, read its
Hindi text with free in-browser OCR (Tesseract.js), check and edit the text, and
download a 1080×1350 PNG. No paid AI API and no Facebook credentials are needed.
Nothing is published to Facebook.

author : ajit baabaaaji

## Current status

See **[docs/STATUS.md](docs/STATUS.md)** for what was tested and how.

| Part | State |
|---|---|
| Upload poster → **free Hindi OCR in the browser** → edit → IBN7 Bharat PNG → download | **Verified** by automated browser tests and by hand. OCR is a first draft: expect 1–2 misread words per poster. |
| Manual text entry when OCR fails or the Hindi data cannot load | **Verified** (browser test with the language data blocked) |
| IBN7 Bharat template (1080×1350), logo upload, headline colours, photo crop, preview, approve, download | Verified (tests + browser). The headline font is an open-source stand-in until the brand font is supplied. |
| History, duplicate detection, retries, fact check | Verified (tests) |
| **Automatic Facebook monitoring** | **Unavailable until configured and tested.** No credentials or Page URL yet. The dashboard says *"not configured – manual import only"*, then *UNVERIFIED* until a real new post has been processed. |
| Optional paid extraction (Claude vision) | Off. Only runs if `EXTRACTION_PROVIDER=anthropic` is set explicitly. Not part of the free workflow. |

## Start the app

Requires Node.js 22.13+. From the project folder:

```bash
npm install                      # once: app + free OCR engine and Hindi/English data
npx playwright install chromium  # once: the headless browser that renders the PNG
npm start                        # dashboard + worker on http://localhost:3000
```

On Linux servers use `npx playwright install --with-deps chromium` to also install the
browser's system libraries. Without `ADMIN_PASSWORD` the dashboard has no login, which
is fine on your own computer. Set one before anyone else can reach it
(docs/CONFIGURATION.md).

## Make a poster (free workflow)

1. **Branding & template** tab: upload the official IBN7 Bharat logo (once). Until a
   logo is uploaded, posters are marked DRAFT and cannot be approved.
2. **Manual import** tab: choose the poster image saved or screenshotted from Facebook,
   optionally paste the post link, and press **Import & generate**.
3. The editor opens and **reads the Hindi text automatically** (status under *Read text
   (OCR)*, about 5–15 s; the first run also loads the language data). For a phone
   screenshot, drag a box around the poster's text on the source image and press
   **Read text (OCR)** again for a cleaner result.
4. **Check every word** against the source image and correct OCR mistakes. Select words
   and press **Red** / **Blue** to colour them. Enter starts a new headline line.
   *Red box line* is the quote attribution (`- नाम, पद`). If OCR fails, the status line
   says so; just type the text.
5. Drag a box over the photo on the source image and press **Use selected area as
   photo** (or upload a different photo).
6. Press **Save & re-render**, review the generated poster and the fact-check notes,
   press **Approve**, then **Download PNG** (1080×1350).

Terminal check of the OCR on any image: `npm run ocr:check -- path/to/poster.jpg`.

## Automatic monitoring (optional, not yet available)

The app can also poll Facebook Pages through the official Graph API and queue new
posters for the same editor. It needs Facebook credentials and Page access, and it has
not yet been tested against a real Page. Read **[docs/FACEBOOK_ACCESS.md](docs/FACEBOOK_ACCESS.md)**
first: Pages owned by other outlets (such as Live Cities) can generally only be read if
they grant your business access.

```
 Facebook Graph API ──poll──► monitor ──new photo posts──► jobs (SQLite)
                                                            │
 Manual import ─────────────────────────────────────────────┤
                                                            ▼
     dashboard ◄── edit (OCR / typing) · colour · crop ◄── download + dedupe
         │
         └──► render (Chromium, IBN7 template) ──► review · approve · PNG
```

## Docs

* **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**: settings and secrets (none needed for the free workflow)
* **[docs/TEMPLATE.md](docs/TEMPLATE.md)**: logo, reference posters and the IBN7 template
* **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**: running it on a server
* **[docs/FACEBOOK_ACCESS.md](docs/FACEBOOK_ACCESS.md)**: what automatic monitoring would need
* **[docs/STATUS.md](docs/STATUS.md)**: what is verified and what is not

## Layout

```
src/
  main.js               entry point: web | worker | all
  server.js             dashboard API (HTTP Basic auth); serves the OCR engine + language data
  worker.js             scheduler loop + job runner
  facebook/             URL parsing, Graph API client, monitor (optional)
  pipeline/             facts, template, render (Chromium), process; extract.js = optional paid path
  jobs.js posts.js db.js logger.js imagehash.js
  cli/fb-check.js       live access check against real Pages
public/
  app.js                dashboard, including in-browser OCR (Tesseract.js)
  ocr-map.js            OCR lines -> poster fields (shared with tests)
scripts/                ocr:check, render:sample, extract:check (paid, optional)
templates/ibn7bharat/   IBN7 Bharat template (default) + reference posters
templates/placeholder/  neutral fallback template (output always DRAFT)
test/                   node:test suites (npm test)
```
