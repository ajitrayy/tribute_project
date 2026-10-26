# What works, and what has not been tested yet

Last updated with the IBN7 Bharat template work. "Verified" below means it was run
for real (automated tests and/or a browser session against the running app), not
just written.

## Verified working

| Feature | How it was verified |
|---|---|
| Manual import → editor → PNG download | Browser end-to-end run against the running app: upload logo → import poster → type headline → colour words with the Red/Blue buttons → drag-crop photo from the source → render → approve → download. The PNG was 1080×1350. |
| IBN7 Bharat template (`templates/ibn7bharat`) | Rendered with the text of the supplied Bihar poster and compared side by side with the original. Logo position, red rules, headline colours, line layout, photo fade, footer and red bar match. |
| Hindi text rendering | Conjuncts and matras render correctly in Chromium with embedded fonts. Renders fail loudly if a font does not load. |
| Logo never distorted | Test renders a 4:1 logo and measures it: drawn at 224×56 (fixed height, natural width), centred. |
| Headline colour markup `[r]…[/r]` `[b]…[/b]` | Unit tests (escaping, bad/nested tags) and a pixel check for red and blue text on the poster. |
| Photo from the source poster | Manual drag-crop verified in the browser. Cropping code covered by tests. |
| Fact check | Unit tests: changed or extra numbers, dropped names/places, source branding, fields the template does not print. |
| Duplicate detection, job retries/backoff, stale-job recovery | Unit tests. |
| Monitoring controls (interval, pause/resume, check now) | API tests and browser run. |
| Page access errors are explained | Adding a Page with no credentials shows "no access" with the reason (browser run). |

## Implemented but NOT yet tested for real

| Feature | Why not | How to test it |
|---|---|---|
| **Automatic Facebook monitoring** | No Facebook credentials have been supplied, the source Page ("Live Cities") URL is not known, and this build environment cannot reach facebook.com. Only tested against a simulated Graph API. | Set the FB_* variables, then `npm run fb:check -- <page url>`. Add the Page in the dashboard and wait for a new post. The dashboard shows **"Facebook monitoring UNVERIFIED"** until a real post detected on a Page has been processed into a poster. It then marks that Page verified, with a link to the post. |
| **Automatic text extraction (Claude vision)** | No `ANTHROPIC_API_KEY` in the build environment. | Set the key, then `npm run extract:check -- poster.jpg`. Then import a poster in the dashboard and check that the text and colours are filled in. |
| **Automatic photo crop** (model-chosen photo area) | Depends on automatic extraction. | Same as above. Check the "Photo" box in the editor. |
| Docker image build | Docker builds were not run here. | `docker compose up -d --build`. |

## Known gaps

* **Headline font**: the brand's own font file was not supplied. The template uses Noto
  Sans Devanagari ExtraCondensed Black (open source), compressed and stroked to match
  the size, weight and line widths of the reference posters. Letter shapes differ
  slightly. Send the font file and it will be swapped in (docs/TEMPLATE.md).
* **Logo**: the dashboard needs the official logo file. Until one is uploaded, posters
  are drafts and cannot be approved. The browser test used a crop of the reference
  poster as a stand-in. It was not committed.
* **Footer icons** (`assets/footer-social.png`) are cut 1:1 from the reference poster.
  A vector export would be sharper.
* **Live Cities** is another outlet's Page. Reading it through the Graph API needs
  either their permission (they add your business as a partner on their Page) or Meta's
  Page Public Content Access. See docs/FACEBOOK_ACCESS.md. Until then, use Manual import.
