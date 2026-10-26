# What works, and what has not been tested yet

The app runs as a **free workflow**: no paid AI API and no Facebook credentials are
needed to turn an uploaded poster into an IBN7 Bharat PNG. "Verified" below means it
was run for real (automated tests and/or a browser session against the running app),
not just written.

## Verified working (free workflow, no API keys)

| Feature | How it was verified |
|---|---|
| **Upload poster → Hindi OCR in the browser → edit → 1080×1350 PNG** | `test/browser-ocr.test.js` drives the real dashboard in headless Chromium: upload the reference poster, the editor runs Tesseract.js OCR, fills the headline, saves, and the downloaded PNG is 1080×1350. Also run by hand against the running app with both reference posters and a full phone screenshot. |
| **OCR runs locally, with no outside services** | The OCR engine and the Hindi + English language data are served by the app itself (`/vendor/...`). The browser test asserts no request leaves the app's own server. |
| **Fallback to manual typing** | Browser test blocks the Hindi language data: the editor says *"OCR could not run … Type the poster text in the fields instead"* within seconds, the text is typed, and the PNG renders. API test: typing with no OCR at all also renders. |
| OCR accuracy on the supplied posters | Bihar poster: 3 headline lines, ~77–83 % confidence, typically 1–2 wrong words (e.g. मेहनत → प्रेहनत, येलो misread). ITBP poster: 3 headline lines plus the red-box line `- शत्रुजीत कपूर, DG (ITBP)` read correctly. Full Facebook phone screenshot: app text gets mixed in. Selecting just the poster's text area gives the 3 headline lines at ~94 %. |
| Paid AI is off | With `ANTHROPIC_API_KEY` set but `EXTRACTION_PROVIDER` unset, the app stays in the free mode (`test/manual-workflow.test.js`). |
| Manual import needs no Facebook credentials | API test runs the whole import → PNG flow with no Facebook settings and a network-blocking Graph client. |
| IBN7 Bharat template, logo upload, headline colours, photo drag-crop, preview, approve, download | Browser regression run: logo upload → import → colour words → drag-crop photo → render → approve → download 1080×1350 PNG. Plus template pixel tests (logo 224×56 for a 4:1 logo, red/blue headline text). |
| Fact check against OCR text | Numbers that differ from the OCR text are flagged as warnings that point back to the source image (OCR can misread digits). |
| Duplicate detection, job retries, stale-job recovery | Unit tests. |

`npm test` runs 40+ tests, including the real OCR engine on the reference poster and the
browser tests.

## Not available / not verified

| Feature | State |
|---|---|
| **Automatic Facebook monitoring** | **Unavailable until configured and tested.** No Facebook credentials or Live Cities Page URL have been supplied, and the build environment could not reach facebook.com. The dashboard header says *"Facebook monitoring: not configured – manual import only"*. After credentials are added it says *UNVERIFIED* until a real new post detected on a Page has been processed into a poster. Code was tested only against a simulated Graph API. |
| Optional paid extraction (Claude vision) | Present in the code but **off**. It runs only if `EXTRACTION_PROVIDER=anthropic` is set explicitly. Never run with a real key. Not part of the free workflow. |
| Docker image build | Not run here. |

## Known limits of the free OCR

* OCR is a first draft. **Every result must be checked against the source image**
  before saving. The status line says so after each run.
* Small or blurry screenshots read worse. Crop to the poster first, or drag-select the
  text area in the editor and press **Read text (OCR)**. The small white-on-red quote
  box in a low-resolution phone screenshot was not read and had to be typed.
* Headline colours are not detected by OCR. Use the **Red / Blue / Black** buttons.
* The photo is not detected automatically. Drag-select it on the source image, or
  upload one.
* First use downloads about 4.5 MB of language data from your own server into the
  browser. Later runs are cached.
* Headline font: the brand font file was not supplied. The template uses an
  open-source stand-in matched to the reference (docs/TEMPLATE.md).
