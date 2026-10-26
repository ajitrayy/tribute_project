# Installing the official IBN7 Bharat template

The app ships only `templates/placeholder/`: a neutral grey layout that does **not**
attempt the IBN7 Bharat look. Everything rendered with it is stamped
**DRAFT - NOT FOR PUBLICATION** and cannot be approved. The official template must be
built from the reference posters and logo you supply, and it is the only source of
truth for logo placement, colours, typography, headline hierarchy, footer, margins and
dimensions.

## What is needed from you

1. **Reference posters**: 3–5 real IBN7 Bharat posters, ideally at full resolution and
   covering the variants you use (breaking strap, with photo, without photo, long and
   short headlines).
2. **The official logo**: SVG or a transparent PNG at least twice the size it appears on
   the poster.
3. **The fonts** used on the posters, as font files you are licensed to embed, or their
   names if they are Google/Noto fonts.
4. Any written brand rules (exact colour codes, minimum logo clear space, etc.).

## How a template is built

```
templates/ibn7bharat/
  template.json      # dimensions and flags
  template.html      # layout (HTML + CSS), Mustache placeholders
  fonts/…            # embedded font files
  assets/…           # fixed artwork (frames, strap backgrounds, textures)
  reference/…        # the official reference posters, shown in the dashboard
```

`template.json`:

```json
{
  "name": "IBN7 Bharat – standard",
  "placeholder": false,
  "width": 1080,
  "height": 1350,
  "scale": 1,
  "requiresLogo": true
}
```

* `width`/`height` are the output size in CSS pixels; `scale` multiplies them (2 → a
  2160×2700 PNG with the same layout). Use the reference posters' exact pixel size.
* `placeholder: false` marks this as the approved template. Only set it once the layout
  matches the references.

`template.html` is a full HTML page sized to `width × height`. Available values:

| Placeholder | Content |
|---|---|
| `{{category_label}}` | strap such as ब्रेकिंग न्यूज़ (may be empty) |
| `{{headline}}` | main headline |
| `{{subheadline}}` | secondary line (may be empty) |
| `{{#body_lines}}…{{.}}…{{/body_lines}}` | additional lines; `{{#has_body}}` is true if any |
| `{{location}}`, `{{date_text}}` | only if printed on the source poster |
| `{{{logo_src}}}` / `{{#has_logo}}` | the uploaded official logo (data URI) |
| `{{{photo_src}}}` / `{{#has_photo}}` | optional photo an editor uploaded for this poster |
| `{{asset:fonts/x.woff2}}` | any file in the template folder, inlined as a data URI |

Rules that keep output sharp and on-brand:

* Draw the logo with `<img src="{{{logo_src}}}">` inside a fixed box and
  `object-fit: contain`. **Never** set both width and height on the image without
  `object-fit: contain`, or it will be stretched.
* Embed fonts with `@font-face` + `{{asset:…}}`. The renderer blocks all network
  requests and fails the render if a declared font does not load, so nothing silently
  falls back to a system font.
* Add `data-fit="headline" data-fit-min="40"` to text boxes with a fixed height. The
  renderer shrinks the font size 1px at a time until the text fits, down to the
  minimum. If it still overflows, the dashboard warns the editor to shorten the text.
* Text values are HTML-escaped. Use double braces for text and triple braces only for
  the `*_src` data URIs.

## Checking a template

```bash
npm run render:sample -- ibn7bharat sample.png path/to/logo.png
```

Compare `sample.png` with the reference posters (the dashboard's *Branding & template*
tab shows them side by side). When it matches, select the template in the dashboard
and press **Re-render all** on the Posters tab.
