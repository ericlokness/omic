# Olympic Mountain Ice Cream — Website Project Handoff

_Handoff notes to resume work in a new Claude session. Give this file (and the site zip) to the next session for full context._

## What this is
A single-page marketing website for **Olympic Mountain Ice Cream** (OMIC), a family-owned Washington State ice cream & sorbet maker (Shelton, WA; founders Karl & Bev Black; family owned since 1984; phone 360-426-0696; olympicmountainicecream.com). Built as a **single static `index.html`** for deployment on **Cloudflare Pages**. The owner's stack preference is static single-file HTML + Cloudflare (Pages/KV/Zero Trust/Email Routing).

## Deliverable structure
```
omic-site/
├── index.html          (~112 KB — all HTML, CSS, JS inline in one file)
├── robots.txt          (allows all; references sitemap)
├── sitemap.xml         (single-page sitemap)
└── images/             (28 files, all WebP, ~1.3 MB total)
```
Final zip lives at `/mnt/user-data/outputs/olympic-mountain-ice-cream-site.zip`.
Deploy = upload the `omic-site` contents to Cloudflare Pages.

## Page sections (top → bottom, in order)
1. **Nav** — fixed bar; desktop links, mobile hamburger drawer (drawer is a body-level element `#navDrawer`, NOT nested in `<nav>`, to avoid a `backdrop-filter` containing-block bug).
2. **Hero** — logo, tagline, "Family Owned Since 1984"; subtle small **white** twinkling stars only (gold sparkles were removed); "Scoop In" scroll indicator in gold, centered.
3. **Gallery** — auto-scroll marquee of flavor photos.
4. **Flavors** ("The Flavor Library") — see detailed notes below.
5. **Take a Pint (pint band)** — pure black background, copper edge-fade only; pint-lid image + 5 pint pack-shots gallery.
6. **Where to Find** — Leaflet map + county-grouped accordion of all locations.
7. **Story** — dark navy; Karl & Bev narrative, drop cap, pull quote, ingredients card.
8. **Reviews / Awards** — dark band; Foodie.com "Best in Washington" award.
9. **FAQ** — light; `<details>` accordion.
10. **Contact** — order form (Web3Forms), phone, address.
11. **Footer** — logo + tagline.

## Design system
- Palette CSS vars: `--midnight #0a1424, --dusk #16283f, --horizon #24405f, --snow #eef3f9, --glacier #a9c0d8, --copper #c08a4d, --copper-bright #d9a96a, --cream #f6efe3, --cream-deep #efe5d2, --ink #22293a, --ink-soft #4d5568`.
- Fonts: **Fraunces** (display) + **Karla** (body) via Google Fonts. Loaded ASYNC (preload → stylesheet swap, with `<noscript>` fallback). Only specific weights requested (Fraunces 400/500/600/700 + italics 400/500; Karla 400/600/700 + italic 400) — NOT the full variable range.
- Background alternation dark/light down the page: Hero(dark)→Gallery(dark)→Flavors(light)→Pint(black)→WhereToFind(light)→Story(dark)→Reviews(dark)→FAQ(light)→Contact(dark).

## FLAVORS SECTION — important details
- **238 flavors total: 161 ice creams + 77 sorbets.** Both lists are **STATIC HTML** in the markup (`<ul id="icList">`, `<ul id="soList">`), rendered at page-parse time. This was a deliberate perf fix — earlier the list was JS-generated and caused a 0.5–1s mobile stall. **Do NOT reintroduce JS-based list building.** The JS only *filters* existing `<li>` nodes (cached lowercase key per item).
- Both lists are **alphabetical**.
- **Tags** on flavors (rendered as pills after the name):
  - `seasonal` — green pill. Limited seasonal batch.
  - `booze` — copper pill. Made with wine/spirits, additional cost (sorbets).
  - `popular` — **purple pill with a ★ star**. Customer favorite.
- **Cost/seasonal scheme (authoritative):** one star `*` in source data = seasonal; two stars `**` = additional cost (booze). Sorbet "Gauva Lime" typo was corrected to "Guava Lime".
- **Popular flavors (16 total), tagged with `class="is-popular"`:**
  - Ice cream (10): Madagascar Vanilla, Bordeaux Cherry Chocolate Chip, Salted Caramel, Mint Chocolate Chip, Toasted Coconut, Kentucky Pie, Whiskey Caramel Praline, Peanut Butter Oreo, Chocolate, Kahlua Chip.
  - Sorbet (6): Spiced Pear, Watermelon, Blackberry Lemon, Boysenberry, Raspberry Lemon, Strawberry Rhubarb.
- **TWO VIEWS (responsive):**
  - **Desktop (>760px):** full alphabetical lists shown, popular items highlighted inline.
  - **Mobile (≤760px):** only `.is-popular` items show by default; a **"Show all …" button** (`.flavor-showall`, one per list, `data-target="icList"/"soList"`) toggles `.show-all` on the `<ul>` to reveal everything. Pure-CSS hiding (`.flavor-cols:not(.show-all) li:not(.is-popular){display:none}`) + tiny JS toggle.
  - Searching (via `#flavorSearch`) force-adds `.show-all` so matches aren't hidden; clearing the search restores the popular-only mobile view.
- Custom callout under the lists: "Don't see your flavor? Let's make it" (mentions custom flavors, e.g. Curry Oyster; phone 360-426-0696).

## WHERE TO FIND — map & locations
- **Leaflet 1.9.4**, loaded **LAZILY**: the CSS+JS are injected by `loadLeaflet()` only when the map (`#omicMap`) is ~500px from viewport (IntersectionObserver). This keeps Leaflet off the critical render path. `buildMap()` runs on script load.
- Tiles: **CARTO Voyager** (`{s}.basemaps.cartocdn.com/rastertiles/voyager/...`). Switched from OpenStreetMap tiles which threw 403 (referer-required) errors.
- Attribution: minimal "© OpenStreetMap © CARTO", styled very subtle (7.5px, transparent bg, ~55% opacity, brightens on hover). Leaflet flag icon hidden via CSS.
- **Coordinates are approximate** — reverse-engineered from an old WordPress Google-Maps-plugin pixel dump (Seattle-area accurate to feet; distant points can be several miles off). Each pin has a Google Maps link for exact directions; a note says positions are approximate. Geocoding services are NOT on the container network allowlist, so real coords couldn't be looked up. **If the owner can export the real address list, replace the coords for precision.**
- Data in JS: `RETAIL_PTS` (12 pint retailers, copper pins) + `SCOOP_PTS` (~197 scoop/restaurant spots, navy pins). (A dead `PINTS` array was removed.)
- **Locations list**: single combined **county-grouped accordion** (`<details class="loc-county">`), ordered by MOST places first: King (96), Mason (29), Thurston (27), Pierce (20), Snohomish (19), Kitsap (6), Grays Harbor (4), Lewis (2), Jefferson (1). Pint retailers get a gold " — pints" suffix. Search box `#pintSearch` filters all locations + map pins.

## CONTACT FORM — Web3Forms
- Form `#orderForm` POSTs to `https://api.web3forms.com/submit` via async `fetch` (stays on page; shows success/error divs).
- **Current access key: `23aff677-d78f-4997-9eb7-50157f79d02d`** (a testing key; the prior key was `2ce582e6-4658-4857-bd18-c8bca1c9d7a0`).
- Includes hidden `subject`, `from_name`, and a **honeypot** field (`botcheck`, `.hp-field` hidden via CSS) for spam protection.
- **Gotcha:** Web3Forms won't deliver until the destination email on that key is verified (one-time confirmation email). Test from the live Cloudflare URL, not a local `file://` (CORS).

## Foodie award (Reviews section)
- Foodie.com named OMIC "Best Ice Cream Parlor" for Washington (article: The Best Ice Cream Parlors in Every US State, by Scheenagh Harrington, Dec 30 2025; URL https://www.foodie.com/2059672/best-ice-cream-parlors-every-state-list/).
- Image loads from Foodie's CDN URL with `onerror` fallback to local `images/foodie-award.webp`.

## Performance work already done (don't regress these)
- All images resized to display size + converted to **WebP** (folder went from ~9.8 MB → 1.3 MB).
- Flavor & location lists are **static HTML**, filtered (not built) by JS.
- `content-visibility:auto` on heavy below-fold sections (pints, story, reviews, faq, contact) — **NOT** on flavors (it caused an open-time layout spike there).
- Flavor lists use CSS `column-count` (not grid) for cheap layout.
- Leaflet + its CSS lazy-loaded; Google Fonts async; render-blocking resources removed from `<head>`.
- Flavor section images are `loading="eager"` (near top); lower images `loading="lazy"`.
- Removed dead JS: old flavor data arrays, `PINTS` array.

## Known open items / possible next steps
- Replace approximate map coordinates with real geocoded ones if the owner supplies addresses.
- Confirm Web3Forms email verification for the live key; swap back to production key when done testing.
- Ideas discussed but NOT implemented for the long flavor list (mobile now uses popular+Show-all, which was chosen): category filter chips, alphabet jump bar, dedicated /flavors page. Chips would need per-flavor category tagging.
- Consider Cloudflare Polish (paid) to auto-serve AVIF/WebP instead of manual conversion.

## Environment notes for the next session
- Work dir: `/home/claude/omic-site/`. Outputs copied to `/mnt/user-data/outputs/`.
- Validate after edits: HTML via Python `html.parser`; JS via `node -e "new Function(<script IIFE body>)"`; check every `images/*.webp` ref resolves; then `zip -rq` the folder to outputs and `present_files`.
- Container filesystem/tooling can reset between turns — always re-verify on-disk state before assuming prior edits persisted.
