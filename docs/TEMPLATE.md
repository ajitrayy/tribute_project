# The IBN7 Bharat template

`templates/ibn7bharat/` is built from the official reference posters supplied by
IBN7 Bharat and is the default template. `templates/placeholder/` is a neutral grey
fallback whose output is always a DRAFT.

## Where to put brand assets

| Asset | Where |
|---|---|
| **Official logo** (SVG, or transparent PNG ≥ 300 px tall) | Dashboard → **Branding & template** → *Official logo* → Upload. Stored byte-for-byte in `DATA_DIR/assets/`. Drawn 56 px tall at natural width, centred between the red rules. Until a logo is uploaded, every poster is a DRAFT and cannot be approved. |
| **Reference posters** | `templates/ibn7bharat/reference/` in the repository. They appear on the Branding tab for side-by-side checks. |
| **Brand font files** (if IBN7 uses a licensed font) | `templates/ibn7bharat/fonts/`, then point the `@font-face` rules in `template.html` at them. |
| **Footer artwork** (social icons + "// IBN7BHARAT") | `templates/ibn7bharat/assets/footer-social.png`. Currently cut 1:1 from the reference. Replace with a vector/2× export if you have one. |

After changing anything under `templates/`, restart the app and press **Re-render all**
on the Posters tab.

## How the IBN7 Bharat layout works

Measured from `reference/01-bihar-weather.jpg` (1080×1350):

* Logo at y 49–105, centred, with 2 px red rules either side at y 79.
* Headline centred, about 3 lines on a ~138 px pitch, in a heavy condensed face. Each
  word is black unless marked:
  * `[r]words[/r]` → red (#e0141b)
  * `[b]words[/b]` → blue (#0130a4)
  * a new line in the headline field forces a line break.

  In the editor, select words and press **Red** / **Blue** / **Black**. Automatic
  extraction suggests colours, and the app checks that the words themselves were not
  changed.
* *Sub-headline* prints as the white-on-red box used for quote attributions
  (`- शत्रुजीत कपूर, DG (ITBP)`). *Body lines* print as smaller black lines.
* The photo fills the space down to the footer and fades to white at its top. It comes
  from (a) the area automatic extraction picks on the source poster, (b) an area the
  editor drags on the source image, or (c) an uploaded photo.
* Footer: white band with social icons and handle, 16 px red bar.
* Long headlines shrink automatically. If one still does not fit, the editor is told to
  shorten it.
* Label/strap, location and date are not printed by this layout. If the source has them,
  the fact check says so, so they can be moved into the headline or body.

## Building or changing a template

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
* `fields` lists which fields the layout prints. The editor hides the others, and
  `fieldLabels` renames them.

`template.html` is a full HTML page sized to `width × height`. Available values:

| Placeholder | Content |
|---|---|
| `{{category_label}}` | strap such as ब्रेकिंग न्यूज़ (may be empty) |
| `{{headline}}` | main headline, colour markup removed |
| `{{{headline_html}}}` | headline with `[r]`/`[b]` turned into `<span class="r">`/`<span class="b">` and newlines into `<br>` (escaped) |
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
