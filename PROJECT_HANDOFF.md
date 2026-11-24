# Olympic Mountain Ice Cream — Website Project Handoff

_Handoff notes to resume work in a new Claude session. Give this file (and the site zip) to the next session for full context._

## Update — November 2026 (read this first; the sections below are the original September notes)

**Live site:** https://olympicmountainicecream.pages.dev (Cloudflare Pages). Deploy with `node tools/deploy.mjs` (see "Shop (Stripe)" below), not by uploading a zip: a dashboard upload can't deploy functions and would publish `tools/`, `functions/` and `shop-data.xlsx` as public files. `olympicmountainicecream.com` still points to the old Apache host, so `robots.txt`, `sitemap.xml`, `llms.txt`, `.well-known/ard.json` and the JSON-LD in `index.html` use the pages.dev address — switch them when the domain moves to Cloudflare.

**Repository:** this folder is the repo root (`github.com/ericlokness/omic`). When building the Cloudflare upload zip, leave out `.git/`, `.gitignore` and this file. Unused original `.jpg`/`.png` photos in `images/` are git-ignored.

**Current structure**
```
index.html          home page (adds a "Visit" section, social links, inquiry form)
wholesale.html      wholesale ordering page (B2B); Stripe checkout when the shop API is on, else emailed orders
order-complete.html thank-you page after Stripe Checkout (empties the wholesale cart once paid)
functions/api/      shop API for Stripe (Cloudflare Pages Function): /api/catalog, /api/checkout, /api/order
tools/              stripe-setup.mjs (workbook → Stripe) and deploy.mjs (Wrangler deploy); not deployed
shop-data.xlsx      the shop's products, tax, shipping and coupons, as loaded into Stripe; not deployed
404.html            not-found page (stops Cloudflare serving index.html for unknown paths)
robots.txt, sitemap.xml
llms.txt            plain-language guide for AI agents (Lighthouse "Agentic Browsing")
.well-known/ard.json  Agentic Resource Discovery manifest (validated against the ARD schema)
_headers            Cloudflare headers: HSTS, XFO, COOP, nosniff; images cached 7 days
images/             WebP; phone-sized variants are named <name>-440/-480/-540/-640/-660/-800.webp
```

**What changed since September**
- **New creamery (Nov 2026):** moved from the Skokomish Valley to 130 W Corporate Rd, Shelton, WA 98584 (Port of Shelton); scoop shop open 10am–6pm, 7 days; 16 flavors in store. "Visit" section with three snapshot photos, creamery pin on the map (47.24773, -123.15019), updated story/FAQ/contact/footer. The old mailing address was removed.
- **Wholesale page:** sizes Pint $6.75, Quart $13.25, 1.5 gal $49.50, 3 gal $95.80, Gelato pan $39.00 (owner's "Retail" price list). Order builder with flavor search. Orders are emailed via Web3Forms until Stripe checkout is switched on (see "Shop (Stripe)"). The earlier Shopify dev-store checkout was removed in Nov 2026; `SHOPIFY-SETUP.md` in the parent folder is obsolete.
- **Open decision:** how the owner's "Standard" (delivery) price list applies to orders is undecided; a TODO sits above `prices` in `wholesale.html`.
- **Contact form** is now for flavor ideas, business opportunities and events (topic select; event date field), not orders. Facebook and Instagram links in the contact card and footers.
- **PageSpeed (Nov 20, mobile; Performance / Accessibility / Best Practices / SEO):** home 96 / 97 / 100 / 100, wholesale 94 / 100 / 100 / 100, Agentic Browsing 4/4 on both. A map-note contrast fix (home Accessibility → 100 expected) was made after that test. Done: responsive `srcset` images, sized images, hero logo prioritized and visible from the first frame, flavor-strip images now `loading="lazy"` (they are below the fold on phones; LCP improved), text-safe copper tokens (`--accent-text #8a5a28`, `--accent-display #a8733a`, `--btn #9e6a32`) for AA contrast on light sections, `<main>` landmarks, hidden mobile drawer uses `visibility:hidden`.

## Shop (Stripe) — set up Nov 2026 with the stripe-shop skill
Payment for wholesale orders moves from emailed requests to **Stripe Checkout**. The Stripe Dashboard is the shop admin (products, prices, coupons, orders, refunds). Hosting stays on Cloudflare's free plan.

**How it works:** `wholesale.html` asks `/api/catalog` for Stripe's current prices on load. If the shop API answers with a Stripe product for every size, the button becomes "Continue to secure checkout"; otherwise the page keeps emailing orders through Web3Forms. Checkout sends only size keys, quantities, base and flavor, plus the business details; `functions/api/[[path]].js` looks up each size's default price in Stripe and opens Stripe Checkout. Flavors and business details appear on the payment's metadata (order_1…, business, contact, phone, delivery_date, notes). Stripe collects the delivery address. Custom flavors are marked "(custom)".

**Stripe products** (metadata `key` = the page's size id; `shop=yes`): pint $6.75, quart $13.25, 1.5 $49.50, 3 $95.80, pan $39.00 — the "Retail" list, prices excluding tax. Change a price in the Dashboard by adding a new price to the product and making it the default; the site picks it up within 5 minutes. `shop-data.xlsx` is the record; `node tools/stripe-setup.mjs shop-data.xlsx` loads it (safe to re-run).

**Current state (Nov 22, 2026)**
- Test products are in **Eric's own Stripe sandbox "OMIC sandbox"**, for testing only. For go-live they must be created in the **owner's** Stripe account (run the setup script with a key from that account).
- Tax: **none for now** (`SHOP.tax = "none"`, workbook `tax_mode` none). Washington exempts food and food ingredients from retail sales tax, and packaged ice cream sold unheated without utensils by a food manufacturer isn't "prepared food" (RCW 82.08.0293). The owner's accountant should confirm, especially for wine/spirits flavors (the rule doesn't address food containing alcohol). OMIC still owes B&O tax on these sales; it isn't added at checkout. If tax is ever needed: WA's free address rate lookup (dor.wa.gov URL interface) or Stripe Tax.
- Shipping: no rate yet (delivery fee, area and any minimum order still to decide). Checkout collects a US address and charges no delivery fee until a rate exists.
- Coupons: none yet.
- Open with the owner: Standard vs Retail prices; wine/spirits flavors (surcharge products `booze-<size>` + `addons` in the API's SHOP settings, or email-only); custom flavors paid upfront or request-only; delivery fee/area/minimum; accountant to confirm no sales tax.
- **Preview tested end to end (Nov 22, 2026):** the Preview environment has `STRIPE_SECRET_KEY` (a test restricted key from the OMIC sandbox); Production has no key, so the live site still emails orders. Deployed with `node tools/deploy.mjs olympicmountainicecream preview` to https://preview.olympicmountainicecream.pages.dev (the Cloudflare project's production branch is `main`). `/api/catalog` returned the five sizes in test mode; a test order (2 × Pint + 1 × 1.5 gal tub, $63.00) went through Stripe Checkout, was paid with card 4242, and `/order-complete` showed "Payment received: $63.00" and emptied the cart. The Checkout Session carries the business details and the order lines (base and flavor) in its metadata, plus the delivery address.
- **Checkout branding (Nov 22, 2026):** `SHOP.branding` in `functions/api/[[path]].js` sends Stripe `branding_settings` with every session: display name "Olympic Mountain Ice Cream", midnight background `#0a1424`, copper button `#9e6a32`, pill shapes, Lora font (Stripe's closest to Fraunces; Fraunces/Karla aren't offered), logo `images/logo-cream-v2.png` and icon `images/checkout-icon.png` (PNG because Stripe only accepts PNG/JPG; both are exceptions in `.gitignore`). Because it's in code, it carries over to the owner's account. Receipt emails still use the Dashboard's Branding settings, so set those in the owner's account at go-live.
- **Free and bank-payment orders (Nov 23, 2026):** `/api/order` now reports `paid`, `free` and `pending`. A 100%-off code gives a $0 order with no payment created; Stripe reports such a promotion-code order as `payment_status: "paid"` with `amount_total: 0` (not `no_payment_required`, as first assumed), so `/api/order` treats any completed $0 session as free. ACH Direct Debit, if the owner turns it on (Settings → Payment methods; 0.8% capped at $5), finishes checkout as `unpaid` and clears in up to 4 business days. The thank-you page shows the right message for each and empties the cart. The owner decides whether to deliver before an ACH payment clears; failures show in the Dashboard. Order emails / a daily summary are on hold until the owner is asked how they want orders reported.
- **Preview tests, Nov 23, 2026** (deployed to preview only; production untouched):
  1. **Card order** (4242, $128.50, four lines): passed. Thank-you page "Payment received: $128.50", cart emptied; session `paid` with order lines, business details and branding.
  2. **100%-off code** (`TEST100` → coupon "Preview test: 100% off", max 10 uses, sandbox only; 3 gal tub, $95.80 → $0.00): first run showed "Payment received: $0.00" because the session came back `paid`, not `no_payment_required`. Fixed in `/api/order` (a completed session with `amount_total` 0 is free); after redeploying, the same order's thank-you page says "No payment was needed: your code covered the order." Cart emptied. Normal card orders still report `free: false`.
  3. **ACH Direct Debit** (2 × 3 gal tubs, $191.60): ACH had to be enabled in the sandbox first (Settings → Payment methods → Default → ACH Direct Debit → Enable; Stripe shows a "Webhooks recommended" note). Paid with test routing 110000000 / account 000123456789 entered manually: passed. Thank-you page "Your bank payment is on its way…", cart emptied; session `complete` with `payment_status: "unpaid"`. Because the details were typed in by hand, the PaymentIntent waits for **microdeposit verification** (`requires_action`, verify_with_microdeposits); buyers who link their bank instantly skip this. For go-live, turn on Stripe's microdeposit verification emails to customers (Settings → Customer emails) so manual-entry buyers know to verify, or consider mentioning it on the thank-you page.
- **Payment methods in the OMIC sandbox (Nov 23, 2026):** cards, Apple Pay, Google Pay, Link, Cash App Pay and ACH Direct Debit (US bank account) are on. Google Pay and ACH were off by default and were enabled in the Dashboard (Settings → Payment methods → Default); the Stripe connector can read these settings but not change them. The code doesn't list payment methods, so the account settings decide what checkout shows. Wallet buttons appear only on devices that support them: Google Pay in Chrome or on Android with a card saved in Google Pay, Apple Pay in Safari or on iPhone. Test Google Pay on the preview from such a browser; in test mode Stripe swaps in a test card, so nothing is charged. At go-live, switch the same methods on in the owner's account in **live** mode.
- **Adaptive Pricing is off for this shop (Nov 23, 2026):** `SHOP.adaptivePricing: false` sends `adaptive_pricing[enabled]=false` with every Checkout Session, so the payment page always shows and charges USD, whatever the visitor's location. (Before this, visitors outside the US saw a currency chooser defaulting to their own currency, e.g. EUR from Slovenia, plus local payment methods such as Bancontact, EPS and MB WAY.) Because it's in code, it applies in the owner's account too, whatever their Dashboard setting. Checked on preview: "$49.50" with no currency chooser; payment methods Card, Cash App Pay and US bank account. Cash App Pay comes from the account's payment-method settings; the owner can switch it off there if it doesn't suit wholesale buyers.
- **Gift cards (not built; waiting on the owner):** gift cards would use **Gift Up** (3.49% per card sold), with the cards working as codes on Stripe Checkout. This waits for the owner's answer on whether the creamery wants gift cards. The brand tool has already made the card artwork (below).
  - **Preview page built (Nov 24, 2026, at Eric's request):** `gift-cards.html` (served at `/gift-cards`), made from `tools/snippets/gift-up.html` in the site's own nav, fonts and colours, with the midnight gift card image. Until a real Gift Up ID replaces `YOUR-GIFT-UP-ID` (the `data-site-id` on `#giftUp`), the page shows "Gift cards are coming soon" and doesn't load Gift Up's script. It has `noindex` and isn't in `sitemap.xml`, `llms.txt` or the main nav yet; a "Gift cards" link sits in the footer of every page. `_headers` removes `Cross-Origin-Opener-Policy` on `/gift-cards*` so Gift Up's payment pop-up can open. The wholesale checkout note now says a gift card or promo code goes under "Add promotion code" on Stripe's page (shown only when Stripe checkout is on).
  - **To switch it on:** create the Gift Up account (owner's, connected to the owner's Stripe), put its public ID in `gift-cards.html`, optionally run `GIFTUP_API_KEY=… node tools/giftup.mjs brand` on this computer (the key stays out of the repo and chat), then drop `noindex` and add the page to the sitemap, `llms.txt` and, if wanted, the nav. In-store redemption needs the Gift Up app at the shop; the page only promises online use until the owner decides.
  - **If the owner says no:** delete `gift-cards.html`, the `/gift-cards*` block in `_headers`, the footer "Gift cards" links in `index.html` and `wholesale.html`, and the gift-card sentence in `wholesale.html`'s `enableCheckout`.
- **Brand kit (Nov 24, 2026):** `tools/brand.mjs` read the site and wrote `brand.json` plus `images/brand/`: `checkout-logo.png`, `checkout-icon.png`, `email-logo.png` (light logo on a midnight panel, for white emails), and the gift card designs `gift-card.png` (midnight) and `gift-card-2.png` (copper), 1152 × 768 with a "GIFT CARD" label in Fraunces. It found brand `#0a1424`, accent `#9e6a32`, background `#f6efe3`, text `#22293a`, pill buttons, fonts Karla/Fraunces. It suggests Stripe font "inter" (closest to the Karla body text), but `SHOP.branding` deliberately stays on **"lora"** (closest to the Fraunces headings) with `images/logo-cream-v2.png` and `images/checkout-icon.png`; the `images/brand/` checkout files are spares. `deploy.mjs` leaves out `brand.json`; `images/brand/` is deployed like any image. The tool notes the logo is only 537 px wide; an SVG or a larger PNG of the logo would make a sharper gift card.
  - **To rerun it**, from this folder: `npm install --no-save sharp opentype.js wawoff2` (packages aren't committed), then `node tools/brand.mjs --site-url https://preview.olympicmountainicecream.pages.dev`. Values saved in `brand.json` win over what the site says; flags such as `--accent "#9e6a32"`, `--label "Gift card"`, `--logo path` change one value and save it; `--fresh` reads the site again from scratch. If Google Fonts can't be reached, `npm install --no-save @fontsource/fraunces` and add `--font-file node_modules/@fontsource/fraunces/files/fraunces-latin-600-normal.woff`. Nothing is uploaded; the tool only writes `brand.json` and `images/brand/`.

**Keys** (never in the repo or the chat): Cloudflare secret `STRIPE_SECRET_KEY` = a restricted key with Products, Prices, Shipping rates, Tax rates: Read and Checkout Sessions: Write. Preview environment = test key; production = live key (only at go-live).

**Deploy**
```
npx wrangler login
npx wrangler pages secret put STRIPE_SECRET_KEY --project-name olympicmountainicecream --env preview
node tools/deploy.mjs olympicmountainicecream preview      # https://preview.olympicmountainicecream.pages.dev
node tools/deploy.mjs olympicmountainicecream main         # production (only at go-live)
```
`deploy.mjs` leaves out `functions/`, `tools/`, `*.xlsx`, `*.md`, git and Wrangler files. Until a production key is set, a production deploy keeps emailing orders (the API answers 503 and the page falls back).

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
