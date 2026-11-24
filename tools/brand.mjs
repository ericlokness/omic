#!/usr/bin/env node
/* Read a site's brand (name, colours, fonts, logo) and make the images the shop needs.
 *
 *   npm install --no-save sharp opentype.js wawoff2      (once, in the site folder)
 *   node tools/brand.mjs [site-folder]                   read the site, write brand.json and images/brand/*
 *   node tools/brand.mjs --accent "#9e6a32"              change one value; it is saved in brand.json
 *   node tools/brand.mjs --fresh                         ignore brand.json and read the site again
 *
 * Writes, inside the site folder:
 *   brand.json                        what was found and chosen. Edit it and run again: saved values win over
 *                                     what the site says, and flags win over both.
 *   images/brand/checkout-logo.png    logo for Stripe's payment page          (SHOP.branding.logo)
 *   images/brand/checkout-icon.png    square icon for Stripe, 512 × 512       (SHOP.branding.icon)
 *   images/brand/email-logo.png       logo that reads on a white email        (Gift Up emails)
 *   images/brand/gift-card.png        gift card design, 1152 × 768            (Gift Up artwork; gift-card-2.png
 *                                     too when a second background also suits the logo)
 * and prints the SHOP.branding block for functions/api/[[path]].js.
 *
 * Value flags (saved in brand.json):
 *   --name "Shop name"  --logo path  --icon path
 *   --brand #hex       colour behind the logo: Stripe's page background and the gift card background
 *   --accent #hex      buttons            --background #hex   page background   --text #hex   body text
 *   --font "Family"    body font          --display-font "Family"   headings; draws the card's label
 *   --label "Gift card"   words on the card ("" for none)     --font-file path   .ttf/.otf/.woff/.woff2 for the label
 *   --site-url https://…  where the site is deployed (lets Gift Up fetch the design by link if it wants one)
 * Other flags: --fresh, --offline (don't download the label font from Google Fonts).
 *
 * Nothing is uploaded anywhere. The only network request is fetching the label font from Google Fonts when the
 * site loads its fonts from there.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const STRIPE_FONTS = ["be_vietnam_pro", "bitter", "chakra_petch", "hahmlet", "inconsolata", "inter", "lato", "lora",
  "m_plus_1_code", "montserrat", "noto_sans", "noto_sans_jp", "noto_serif", "nunito", "open_sans", "pridi", "pt_sans", "pt_serif",
  "raleway", "roboto", "roboto_slab", "source_sans_pro", "titillium_web", "ubuntu_mono", "zen_maru_gothic"];
export const CARD = { w: 1152, h: 768 };
const OUT = "images/brand";
const VALUE_FLAGS = {
  "--name": "name", "--logo": "logo", "--icon": "icon", "--label": "label", "--font-file": "fontFile",
  "--brand": "colors.brand", "--accent": "colors.accent", "--background": "colors.background", "--text": "colors.text",
  "--font": "fonts.body", "--display-font": "fonts.display", "--site-url": "siteUrl",
};
const COLOR_KEYS = new Set(["colors.brand", "colors.accent", "colors.background", "colors.text"]);

export async function run(argv, env = process.env, io = {}) {
  const log = io.log || console.log;
  const { positional, flags, values } = parseArgs(argv);
  const dir = path.resolve(positional[0] || ".");
  const sharp = io.sharp || (await loadModule("sharp", "sharp"));
  const jsonPath = path.join(dir, "brand.json");
  const saved = flags.has("--fresh") ? {} : await readJson(jsonPath);
  const keep = { giftup: saved.giftup }; // written by tools/giftup.mjs

  for (const [flag, key] of Object.entries(VALUE_FLAGS)) {
    if (!(flag in values)) continue;
    let v = values[flag];
    if (COLOR_KEYS.has(key)) {
      const c = parseColor(v);
      if (!c) throw new Error(`${flag}: "${v}" is not a colour (use #rrggbb).`);
      v = hex(c);
    }
    setPath(saved, key, v);
  }

  const site = await readSite(dir);
  const warnings = [];
  const notes = [];

  // ---- Name, logo, icon, fonts ----
  const name = saved.name || site.name;
  const logoRel = saved.logo !== undefined ? saved.logo : site.logo;
  const iconRel = saved.icon !== undefined ? saved.icon : site.icon;
  const logoFile = logoRel ? path.resolve(dir, logoRel) : null;
  if (logoRel && !existsSync(logoFile)) throw new Error(`Logo not found: ${logoRel}. Pass --logo path/to/logo.svg`);
  if (!logoRel) warnings.push("No logo found on the site. Pass --logo path/to/logo (SVG or PNG works best).");
  const logo = logoFile ? await logoInfo(sharp, logoFile) : null;

  const fonts = {
    body: saved.fonts?.body || site.fonts.body || null,
    display: saved.fonts?.display || site.fonts.display || saved.fonts?.body || site.fonts.body || null,
  };
  fonts.stripe = saved.fonts?.stripe && STRIPE_FONTS.includes(saved.fonts.stripe)
    ? saved.fonts.stripe : stripeFont(fonts.body, fonts.display, site.fonts.bodyGeneric);

  // ---- Colours ----
  const background = saved.colors?.background || (site.colors.background && hex(site.colors.background)) || "#ffffff";
  const text = saved.colors?.text || (site.colors.text && hex(site.colors.text)) || hex(bestText(parseColor(background)));
  const accent = saved.colors?.accent || (site.colors.accent && hex(site.colors.accent)) || text;
  const candidates = dedupe([
    ...(saved.colors?.brand ? [saved.colors.brand] : []),
    ...(logo?.backdrop ? [hex(logo.backdrop)] : []),
    ...site.colors.brandCandidates.map(hex), background, accent, text, "#ffffff", "#111111",
  ]);
  let brandColor = saved.colors?.brand;
  if (!brandColor) {
    brandColor = logo ? pickBackdrop(logo, candidates).color : candidates[0];
  }
  const brandVis = logo ? visibility(logo, parseColor(brandColor)) : 1;
  if (logo && !logo.opaque && brandVis < 0.75) {
    warnings.push(`The logo is hard to see on ${brandColor} (${Math.round(brandVis * 100)}% of it has 3:1 contrast). Pass --brand with a colour it stands out on.`);
  }

  const brand = {
    ...saved,
    name,
    logo: logoRel || null,
    icon: iconRel || null,
    colors: { brand: brandColor, accent, background, text },
    fonts,
    radius: saved.radius || site.radius || "rounded",
    label: saved.label !== undefined ? saved.label : "Gift card",
    fontFile: saved.fontFile || null,
    siteUrl: saved.siteUrl || null,
    ...keep,
  };

  // ---- Images ----
  const outDir = path.join(dir, OUT);
  await mkdir(outDir, { recursive: true });
  const files = {};
  const C = (s) => parseColor(s);

  if (logo) {
    files.checkoutLogo = `${OUT}/checkout-logo.png`;
    await writeFile(path.join(dir, files.checkoutLogo), await fitPng(sharp, logo, 1000, 400, 512 * 1024));

    files.emailLogo = `${OUT}/email-logo.png`;
    const onWhite = logo.opaque ? 1 : visibility(logo, C("#ffffff"));
    await writeFile(path.join(dir, files.emailLogo), onWhite >= 0.75
      ? await fitPng(sharp, logo, 600, 240, 400 * 1024)
      : await logoPanel(sharp, logo, C(brandColor), 600));
    if (onWhite < 0.75) notes.push("The logo is light, so the email logo sits on a panel in the brand colour.");
  }

  files.checkoutIcon = `${OUT}/checkout-icon.png`;
  const iconFile = iconRel ? path.resolve(dir, iconRel) : null;
  const iconSrc = iconFile && existsSync(iconFile) ? await logoInfo(sharp, iconFile) : logo;
  await writeFile(path.join(dir, files.checkoutIcon), await squareIcon(sharp, iconSrc, C(brandColor), name));

  const labelFont = brand.label ? await loadLabelFont(dir, site, brand, io, flags.has("--offline")) : null;
  if (brand.label && labelFont?.font) notes.push(`Card label drawn in ${labelFont.family} (${labelFont.source}).`);
  if (brand.label && !labelFont?.font) {
    warnings.push(`Couldn't get the ${fonts.display || "site"} font file, so the card label uses a system font. Pass --font-file to fix, or --label "" for no label.`);
  }

  const cardBgs = [brandColor];
  if (logo) {
    const second = candidates.find((c) => distance(C(c), C(brandColor)) > 90 && (logo.opaque ? c !== hex(logo.backdrop || C("#fff")) : visibility(logo, C(c)) >= 0.85));
    if (second && !logo.opaque) cardBgs.push(second);
  }
  files.giftCards = [];
  for (const [i, bg] of cardBgs.entries()) {
    const rel = `${OUT}/gift-card${i ? `-${i + 1}` : ""}.png`;
    await writeFile(path.join(dir, rel), await renderCard(sharp, { bg: C(bg), accent: C(accent), text: C(text), logo, label: brand.label, labelFont, name }));
    files.giftCards.push(rel);
  }
  if (logo && !logo.vector && logo.width < 600) {
    warnings.push(`The logo is only ${logo.width} px wide; an SVG or a larger PNG makes a sharper gift card.`);
  }

  // ---- Checks ----
  const btn = C(accent);
  const white = contrast(btn, C("#ffffff"));
  if (white < 4.5) {
    const black = contrast(btn, C("#000000"));
    warnings.push(black >= 4.5
      ? `White text on the button colour ${accent} is ${white.toFixed(1)}:1; Stripe will likely use dark text there.`
      : `Button colour ${accent} gives low contrast with both white and black text (${white.toFixed(1)}:1). Consider a darker shade with --accent.`);
  }

  brand.images = files;
  delete brand.found;
  brand.found = site.found; // where each value came from, for review
  await writeFile(jsonPath, JSON.stringify(brand, null, 2) + "\n");

  const block = brandingBlock(brand, files);
  log(`Brand for ${name || dir}`);
  log(`  brand ${brandColor}  accent ${accent}  background ${background}  text ${text}`);
  log(`  fonts: body ${fonts.body || "?"}, display ${fonts.display || "?"} → Stripe "${fonts.stripe}"; buttons ${brand.radius}`);
  log(`  logo: ${logoRel || "none"}${logo ? (logo.opaque ? " (solid background)" : "") : ""}`);
  log(`Wrote brand.json and ${Object.values(files).flat().join(", ")}`);
  for (const n of notes) log(`Note: ${n}`);
  for (const w of warnings) log(`Check: ${w}`);
  log("\nPaste into SHOP in functions/api/[[path]].js (deploy the images first; Stripe loads them from the site):\n");
  log(block);
  return { brand, files, warnings, notes, block, labelFont: labelFont?.font ? `${labelFont.family} (${labelFont.source})` : null };
}

export function brandingBlock(brand, files) {
  const lines = [
    `  branding: {`,
    `    display_name: ${JSON.stringify(brand.name || "")},`,
    `    background_color: "${brand.colors.brand}",`,
    `    button_color: "${brand.colors.accent}",`,
    `    border_style: "${brand.radius}",`,
    `    font_family: "${brand.fonts.stripe}",`,
  ];
  if (files.checkoutLogo) lines.push(`    logo: "/${files.checkoutLogo}",`);
  if (files.checkoutIcon) lines.push(`    icon: "/${files.checkoutIcon}",`);
  lines.push("  },");
  return lines.join("\n");
}

/* ---------- Reading the site ---------- */

export async function readSite(dir) {
  const htmlFile = await pickHtml(dir);
  const html = htmlFile ? await readFile(htmlFile, "utf8") : "";
  const base = htmlFile ? path.dirname(htmlFile) : dir;
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const googleFonts = [];
  for (const tag of tags(html, "link")) {
    const a = attrs(tag);
    const href = a.href || "";
    if (/fonts\.googleapis\.com/i.test(href)) googleFonts.push(href.startsWith("//") ? `https:${href}` : href);
    else if (/\bstylesheet\b/i.test(a.rel || "") && isLocal(href)) {
      const f = localPath(dir, base, href);
      if (f && existsSync(f)) css += "\n" + (await readFile(f, "utf8").catch(() => ""));
    }
  }
  for (const m of css.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi)) {
    if (/fonts\.googleapis\.com/i.test(m[1])) googleFonts.push(m[1]);
  }
  css = stripBlocks(css.replace(/\/\*[\s\S]*?\*\//g, ""), /@media[^{]*(prefers-color-scheme|print)[^{]*$/i);
  const rules = cssRules(css);
  const vars = new Map();
  for (const r of rules) for (const [k, v] of Object.entries(r.decls)) if (k.startsWith("--") && !vars.has(k)) vars.set(k, v);
  const res = (v) => resolveVars(v, vars);
  const found = {};

  // Colours
  const meta = metas(html);
  const byRule = (test, prop) => {
    const out = [];
    for (const r of rules) {
      if (!r.selectors.some(test)) continue;
      const c = prop === "bg" ? bgOf(r.decls, res) : r.decls.color && parseColor(res(r.decls.color));
      if (c) out.push(c);
    }
    return out;
  };
  const last = (s) => s.split(/[\s>+~]+/).filter(Boolean).pop() || "";
  const plain = (s) => !/:(hover|focus|active|disabled|visited|focus-visible|focus-within)/i.test(s);
  const isBody = (s) => /^(html|body|html\s+body|:root)$/i.test(s.trim());
  const isHeader = (s) => plain(s) && /^(header|nav)([.#:[]|$)|^[.#](site-header|header|navbar|nav|topbar|masthead|site-nav|main-nav|top-bar)([.#:[]|$)/i.test(last(s));
  const isFooter = (s) => plain(s) && /^footer([.#:[]|$)|^[.#](site-footer|footer)([.#:[]|$)/i.test(last(s));
  const isButton = (s) => plain(s) && /^button([.#:[]|$)|(^|[.#])(btn|button|cta)([-_][\w-]*)?([.#:[]|$)|^a\.(btn|button|cta)/i.test(last(s))
    && !/(ghost|outline|secondary|link|close|toggle|icon)/i.test(last(s));

  const background = byRule(isBody, "bg")[0] || null;
  const textColor = byRule(isBody, "color")[0] || null;
  if (background) found.background = "body background";
  const buttons = byRule(isButton, "bg").filter((c) => !background || distance(c, background) > 20 && c.a > 0.5);
  let accent = mostCommon(buttons);
  if (accent) found.accent = "button background";
  const varColors = [...vars.entries()].map(([k, v]) => [k, parseColor(res(v))]).filter(([, c]) => c);
  if (!accent) {
    const named = varColors.find(([k, c]) => /accent|primary|brand|btn|button|cta|highlight/i.test(k) && saturation(c) >= 0.2);
    const saturated = [...varColors].filter(([, c]) => lightness(c) > 0.2 && lightness(c) < 0.8).sort((a, b) => saturation(b[1]) - saturation(a[1]))[0];
    accent = (named || saturated || [])[1] || null;
    if (accent) found.accent = `CSS variable ${(named || saturated)[0]}`;
  }
  const theme = meta["theme-color"] && parseColor(meta["theme-color"]);
  const brandCandidates = [
    ...(theme ? [theme] : []),
    ...byRule(isHeader, "bg"),
    ...byRule(isFooter, "bg"),
    ...varColors.filter(([k]) => /primary|brand|dark|navy|midnight|night|deep/i.test(k)).map(([, c]) => c),
    ...varColors.map(([, c]) => c),
  ];

  // Fonts
  const familyOf = (rulesTest) => {
    for (const r of rules) {
      if (!r.selectors.some(rulesTest)) continue;
      const f = r.decls["font-family"] || (r.decls.font && r.decls.font.match(/(["']?[A-Za-z][\w\s-]*["']?(,\s*[\w\s"'-]+)*)$/)?.[1]);
      if (f) return res(f);
    }
    return null;
  };
  const bodyStack = familyOf(isBody);
  let displayStack = familyOf((s) => /^h[12](\s*|$)/i.test(s.trim()) || /^(h1|h2)$/i.test(last(s)));
  if (!displayStack) {
    const v = [...vars.entries()].find(([k]) => /display|heading|headline|title/i.test(k));
    if (v) displayStack = res(v[1]);
  }
  const fontFaces = rules.filter((r) => r.selectors.some((s) => /^@font-face$/i.test(s)))
    .map((r) => ({ family: firstFamily(r.decls["font-family"]), weight: parseInt(r.decls["font-weight"]) || 400, style: r.decls["font-style"] || "normal",
      srcs: [...(r.decls.src || "").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]) }))
    .filter((f) => f.family);

  // Name, logo, icon
  const imgs = tags(html, "img").map(attrs);
  const logoImg = imgs.find((a) => /logo/i.test(`${a.src || ""} ${a.class || ""} ${a.id || ""} ${a.alt || ""}`) && a.src && isLocal(a.src));
  let logo = logoImg ? rel(dir, localPath(dir, base, logoImg.src)) : null;
  if (logo) found.logo = "<img> with logo in its name";
  if (!logo) {
    const svg = html.match(/<svg\b[^>]*(class|id|aria-label)="[^"]*logo[^"]*"[^>]*>[\s\S]*?<\/svg>/i);
    if (svg) {
      await mkdir(path.join(dir, OUT), { recursive: true });
      logo = `${OUT}/logo-source.svg`;
      let s = svg[0];
      if (!/xmlns=/.test(s)) s = s.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
      await writeFile(path.join(dir, logo), s);
      found.logo = "inline <svg> with logo in its class";
    }
  }
  const links = tags(html, "link").map(attrs);
  const iconLink = links.find((a) => /apple-touch-icon/i.test(a.rel || "") && isLocal(a.href || ""))
    || links.find((a) => /\bicon\b/i.test(a.rel || "") && /\.(svg|png)(\?|$)/i.test(a.href || "") && isLocal(a.href || ""));
  const icon = iconLink ? rel(dir, localPath(dir, base, iconLink.href)) : null;
  if (!logo && meta["og:image"] && isLocal(meta["og:image"])) logo = rel(dir, localPath(dir, base, meta["og:image"]));

  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim();
  const alt = logoImg?.alt && !/^logo$/i.test(logoImg.alt.trim()) && !/\blogo\b/i.test(logoImg.alt) && logoImg.alt.length <= 60 ? logoImg.alt.trim() : null;
  const name = decode(meta["og:site_name"] || meta["application-name"] || alt || title.split(/\s+[|–—:·-]\s+/)[0] || path.basename(dir));

  const radius = (() => {
    for (const r of rules) {
      if (!r.selectors.some(isButton) || !r.decls["border-radius"]) continue;
      const v = res(r.decls["border-radius"]).trim().split(/\s+/)[0];
      if (/%$/.test(v)) return "pill";
      const n = parseFloat(v) * (/rem|em$/.test(v) ? 16 : 1);
      if (!n) return "rectangular";
      return n >= 20 ? "pill" : "rounded";
    }
    return null;
  })();

  return {
    name, logo, icon, radius, googleFonts, fontFaces, base, found,
    colors: { background, text: textColor, accent, brandCandidates },
    fonts: { body: firstFamily(bodyStack), display: firstFamily(displayStack), bodyGeneric: genericOf(bodyStack) },
  };
}

async function pickHtml(dir) {
  if (existsSync(path.join(dir, "index.html"))) return path.join(dir, "index.html");
  const list = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".html")).sort();
  return list[0] ? path.join(dir, list[0]) : null;
}

export function cssRules(css) {
  const rules = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].trim().split(",").map((s) => s.trim()).filter(Boolean);
    const decls = {};
    for (const d of m[2].split(/;(?![^(]*\))/)) {
      const i = d.indexOf(":");
      if (i > 0) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim().replace(/\s*!important$/i, "");
    }
    rules.push({ selectors, decls });
  }
  return rules;
}

function stripBlocks(css, preludeTest) {
  let out = "", i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) { out += css.slice(i); break; }
    const prelude = css.slice(i, open);
    const at = prelude.lastIndexOf("@");
    if (at >= 0 && preludeTest.test(prelude.slice(at))) {
      let depth = 1, j = open + 1;
      while (j < css.length && depth) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
      out += prelude.slice(0, at);
      i = j;
    } else { out += css.slice(i, open + 1); i = open + 1; }
  }
  return out;
}

function resolveVars(v, vars, depth = 0) {
  if (!v || depth > 6 || !/var\(/.test(v)) return v || "";
  const next = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name, fb) => vars.get(name) ?? fb ?? "");
  return resolveVars(next, vars, depth + 1);
}

function bgOf(decls, res) {
  for (const p of ["background-color", "background"]) {
    if (!decls[p]) continue;
    const c = parseColor(res(decls[p]));
    if (c && c.a > 0.05) return c;
  }
  return null;
}

function firstFamily(stack) {
  if (!stack) return null;
  for (const part of stack.split(",")) {
    const f = part.trim().replace(/^["']|["']$/g, "");
    if (f && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|blinkmacsystemfont|inherit|initial|var\(.*)$/i.test(f)) return f;
  }
  return null;
}

function genericOf(stack) {
  const m = (stack || "").toLowerCase().match(/\b(sans-serif|serif|monospace|cursive|system-ui)\b(?![\s\S]*\b(sans-serif|serif|monospace|cursive|system-ui)\b)/);
  return m ? m[1] : "sans-serif";
}

export function stripeFont(body, display, generic = "sans-serif") {
  const norm = (f) => f && f.toLowerCase().replace(/[\s-]+/g, "_").replace(/^source_sans_3$/, "source_sans_pro");
  for (const f of [body, display]) if (f && STRIPE_FONTS.includes(norm(f))) return norm(f);
  if (/slab/i.test(body || "")) return "roboto_slab";
  if (generic === "monospace") return "inconsolata";
  if (generic === "serif") return "lora";
  if (/rounded|nunito|quicksand|varela/i.test(body || "")) return "nunito";
  return "inter";
}

/* ---------- HTML helpers ---------- */

const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]);
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}
function metas(html) {
  const out = {};
  for (const a of tags(html, "meta").map(attrs)) {
    const k = (a.name || a.property || "").toLowerCase();
    if (k && a.content && !(k in out)) out[k] = a.content;
  }
  return out;
}
const decode = (s) => String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const isLocal = (href) => !!href && !/^([a-z]+:|\/\/|#|data:)/i.test(href);
function localPath(dir, base, href) {
  const clean = decodeURIComponent(href.split(/[?#]/)[0]);
  const p = clean.startsWith("/") ? path.join(dir, clean) : path.resolve(base, clean);
  return p.startsWith(dir) ? p : null;
}
const rel = (dir, p) => (p ? path.relative(dir, p).split(path.sep).join("/") : null);

/* ---------- Colour ---------- */

export function parseColor(input) {
  if (!input) return null;
  if (typeof input === "object") return input;
  const s = String(input).trim();
  const m = s.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(white|black|transparent)\b/i);
  if (!m) return null;
  const t = m[0].toLowerCase();
  if (t === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (t === "black") return { r: 0, g: 0, b: 0, a: 1 };
  if (t === "transparent") return null;
  if (t[0] === "#") {
    let h = t.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  const nums = t.slice(t.indexOf("(") + 1, -1).split(/[\s,/]+/).filter(Boolean);
  const num = (v, max) => (v.endsWith("%") ? (parseFloat(v) / 100) * max : parseFloat(v));
  const alpha = nums[3] !== undefined ? num(nums[3], 1) : 1;
  if (t.startsWith("rgb")) {
    const [r, g, b] = nums.slice(0, 3).map((v) => Math.round(num(v, 255)));
    return [r, g, b].some(Number.isNaN) ? null : { r, g, b, a: alpha };
  }
  const h = parseFloat(nums[0]) / 360, sat = parseFloat(nums[1]) / 100, l = parseFloat(nums[2]) / 100;
  if ([h, sat, l].some(Number.isNaN)) return null;
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
  const f = (t2) => { t2 = (t2 + 1) % 1; return t2 < 1 / 6 ? p + (q - p) * 6 * t2 : t2 < 1 / 2 ? q : t2 < 2 / 3 ? p + (q - p) * (2 / 3 - t2) * 6 : p; };
  return { r: Math.round(f(h + 1 / 3) * 255), g: Math.round(f(h) * 255), b: Math.round(f(h - 1 / 3) * 255), a: alpha };
}
export const hex = (c) => { c = parseColor(c); return "#" + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); };
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const distance = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });
const lightness = (c) => (Math.max(c.r, c.g, c.b) + Math.min(c.r, c.g, c.b)) / 510;
function saturation(c) {
  const mx = Math.max(c.r, c.g, c.b) / 255, mn = Math.min(c.r, c.g, c.b) / 255, l = (mx + mn) / 2;
  return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
}
export const bestText = (bg) => (contrast(bg, { r: 255, g: 255, b: 255 }) >= contrast(bg, { r: 17, g: 17, b: 17 }) ? { r: 255, g: 255, b: 255, a: 1 } : { r: 17, g: 17, b: 17, a: 1 });
function mostCommon(colors) {
  const counts = new Map();
  for (const c of colors) { const k = hex(c); counts.set(k, (counts.get(k) || 0) + 1); }
  let best = null, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best ? parseColor(best) : null;
}
function dedupe(list) {
  const out = [];
  for (const c of list) {
    const p = parseColor(c);
    if (p && !out.some((o) => distance(parseColor(o), p) < 12)) out.push(hex(p));
  }
  return out;
}

/* ---------- Logo analysis ---------- */

async function logoInfo(sharp, file) {
  const buf = await readFile(file);
  const vector = /\.svg$/i.test(file) || /^\s*(<\?xml|<svg)/i.test(buf.subarray(0, 200).toString());
  const meta = await sharp(buf).metadata();
  const { data, info } = await sharp(buf, vector ? { density: 144 } : {}).resize(160, 160, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = [], edge = [];
  let transparent = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    const a = data[i + 3];
    if (a < 128) { transparent++; continue; }
    const c = { r: data[i], g: data[i + 1], b: data[i + 2], a: 1 };
    px.push(c);
    if (x < 2 || y < 2 || x >= info.width - 2 || y >= info.height - 2) edge.push(c);
  }
  const total = info.width * info.height;
  const opaque = transparent / total < 0.02;
  let backdrop = null;
  if (opaque && edge.length) {
    const avg = edge.reduce((s, c) => ({ r: s.r + c.r / edge.length, g: s.g + c.g / edge.length, b: s.b + c.b / edge.length, a: 1 }), { r: 0, g: 0, b: 0, a: 1 });
    if (edge.every((c) => distance(c, avg) < 24)) backdrop = avg;
  }
  return { file, buf, vector, width: meta.width || 0, height: meta.height || 0, px, opaque, backdrop };
}

/** Share of the logo's visible pixels with at least 3:1 contrast against bg. */
export function visibility(logo, bg) {
  if (!logo.px.length) return 0;
  let ok = 0;
  for (const c of logo.px) if (contrast(c, bg) >= 3) ok++;
  return ok / logo.px.length;
}

function pickBackdrop(logo, candidates) {
  if (logo.opaque) return { color: logo.backdrop ? hex(logo.backdrop) : candidates[0] };
  let best = { color: candidates[0], v: -1 };
  for (const c of candidates) {
    const v = visibility(logo, parseColor(c));
    if (v >= 0.8) return { color: c, v };
    if (v > best.v) best = { color: c, v };
  }
  return best;
}

/* ---------- Rendering ---------- */

async function rasterLogo(sharp, logo, maxW, maxH) {
  const ratio = logo.width && logo.height ? logo.width / logo.height : 1;
  let w = Math.min(maxW, maxH * ratio), h = w / ratio;
  if (!logo.vector) { w = Math.min(w, logo.width); h = Math.min(h, logo.height); }
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const density = logo.vector && logo.width ? Math.min(2400, Math.max(72, (72 * w * 2) / logo.width)) : undefined;
  const buf = await sharp(logo.buf, density ? { density } : {}).resize(w, h, { fit: "inside" }).png().toBuffer();
  const m = await sharp(buf).metadata();
  return { buf, w: m.width, h: m.height };
}

async function fitPng(sharp, logo, maxW, maxH, maxBytes) {
  let { buf } = await rasterLogo(sharp, logo, maxW, maxH);
  if (buf.length > maxBytes) buf = await sharp(buf).png({ palette: true, quality: 90 }).toBuffer();
  return buf;
}

async function logoPanel(sharp, logo, bg, width) {
  const r = await rasterLogo(sharp, logo, width * 0.8, width * 0.32);
  const pad = Math.round(width * 0.1);
  const W = width, H = r.h + pad * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="${Math.round(H * 0.12)}" fill="${hex(bg)}"/></svg>`;
  return sharp(Buffer.from(svg)).composite([{ input: r.buf, left: Math.round((W - r.w) / 2), top: Math.round((H - r.h) / 2) }]).png().toBuffer();
}

async function squareIcon(sharp, src, bg, name) {
  const S = 512;
  const base = sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S}" height="${S}" fill="${hex(bg)}"/></svg>`));
  if (!src) {
    const letter = esc((name || "?").trim()[0] || "?");
    const fg = hex(bestText(bg));
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S}" height="${S}" fill="${hex(bg)}"/><text x="256" y="340" text-anchor="middle" font-family="Georgia, serif" font-size="260" fill="${fg}">${letter}</text></svg>`)).png().toBuffer();
  }
  const square = src.width && src.height && Math.abs(src.width / src.height - 1) < 0.1;
  if (src.opaque && square) return sharp(src.buf, src.vector ? { density: 300 } : {}).resize(S, S, { fit: "cover" }).png().toBuffer();
  const box = square ? S * 0.78 : S * 0.86;
  const r = await rasterLogo(sharp, { ...src, vector: src.vector }, box, box);
  return base.composite([{ input: r.buf, left: Math.round((S - r.w) / 2), top: Math.round((S - r.h) / 2) }]).png().toBuffer();
}

export async function renderCard(sharp, { bg, accent, text, logo, label, labelFont, name }) {
  const { w, h } = CARD;
  const dark = lum(bg) < 0.4;
  const lighter = hex(mix(bg, { r: 255, g: 255, b: 255 }, dark ? 0.08 : 0.25));
  const darker = hex(mix(bg, { r: 0, g: 0, b: 0 }, dark ? 0.18 : 0.06));
  const frame = contrast(accent, bg) >= 1.6 ? hex(accent) : hex(mix(bg, bestText(bg), 0.35));
  const labelColor = contrast(accent, bg) >= 3 ? hex(accent) : contrast(text, bg) >= 4.5 ? hex(text) : hex(bestText(bg));
  const words = (label || "").toUpperCase();
  const size = 34, spacing = size * 0.32, baseline = h - 104;
  let labelSvg = "";
  if (words) {
    const t = drawText(words, labelFont?.font, { size, spacing, cx: w / 2, baseline, color: labelColor, family: labelFont?.family });
    const gap = 26, line = 54, y = baseline - size * 0.36;
    labelSvg = t.svg
      + `<line x1="${w / 2 - t.width / 2 - gap - line}" y1="${y}" x2="${w / 2 - t.width / 2 - gap}" y2="${y}" stroke="${labelColor}" stroke-width="2" opacity="0.7"/>`
      + `<line x1="${w / 2 + t.width / 2 + gap}" y1="${y}" x2="${w / 2 + t.width / 2 + gap + line}" y2="${y}" stroke="${labelColor}" stroke-width="2" opacity="0.7"/>`;
  }
  if (!logo && name) {
    const t = drawText(name, labelFont?.font, { size: 72, spacing: 2, cx: w / 2, baseline: h * 0.5, color: hex(bestText(bg)), family: labelFont?.family });
    labelSvg += t.svg;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><radialGradient id="g" cx="50%" cy="32%" r="80%"><stop offset="0" stop-color="${lighter}"/><stop offset="0.55" stop-color="${hex(bg)}"/><stop offset="1" stop-color="${darker}"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<rect x="36" y="36" width="${w - 72}" height="${h - 72}" rx="28" fill="none" stroke="${frame}" stroke-width="2.5" opacity="0.85"/>
${labelSvg}
</svg>`;
  const layers = [];
  if (logo) {
    const maxH = words ? h * 0.42 : h * 0.5;
    const r = await rasterLogo(sharp, logo, w * 0.6, maxH);
    let input = r.buf;
    if (logo.opaque && !logo.backdrop) {
      const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${r.w}" height="${r.h}"><rect width="${r.w}" height="${r.h}" rx="${Math.round(Math.min(r.w, r.h) * 0.08)}"/></svg>`);
      input = await sharp(r.buf).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    }
    const cy = words ? h * 0.44 : h * 0.5;
    layers.push({ input, left: Math.round((w - r.w) / 2), top: Math.round(cy - r.h / 2) });
  }
  let img = await sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel: 9 }).toBuffer();
  if (img.length > 900 * 1024) img = await sharp(img).png({ palette: true, quality: 95, dither: 0.5 }).toBuffer();
  return img;
}

function drawText(text, font, { size, spacing, cx, baseline, color, family }) {
  let glyphs = null;
  if (font) {
    const chars = [...text];
    try { glyphs = chars.map((ch) => font.charToGlyph(ch)); } catch { glyphs = null; } // no shaping: labels are plain capitals
    if (glyphs?.some((g, i) => !g || (g.index === 0 && chars[i].trim()))) glyphs = null; // a character the font lacks
  }
  if (font && glyphs) {
    const scale = size / font.unitsPerEm;
    const xs = [];
    let x = 0;
    glyphs.forEach((g, i) => {
      xs.push(x);
      x += (g.advanceWidth || 0) * scale;
      if (i < glyphs.length - 1) x += spacing + font.getKerningValue(g, glyphs[i + 1]) * scale;
    });
    const x0 = cx - x / 2;
    const d = glyphs.map((g, i) => g.getPath(x0 + xs[i], baseline, size).toPathData(2)).join(" ");
    return { svg: `<path d="${d}" fill="${color}"/>`, width: x };
  }
  const approx = text.length * size * 0.62 + (text.length - 1) * spacing;
  const fam = [family && `'${family.replace(/'/g, "")}'`, "Georgia", "'Helvetica Neue'", "Arial", "sans-serif"].filter(Boolean).join(", ");
  return { svg: `<text x="${cx}" y="${baseline}" text-anchor="middle" font-family="${fam}" font-size="${size}" letter-spacing="${spacing}" font-weight="600" fill="${color}">${esc(text)}</text>`, width: approx };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------- Label font ---------- */

async function loadLabelFont(dir, site, brand, io, offline) {
  let opentype;
  try { opentype = io.opentype || (await import("opentype.js")).default; } catch { return null; }
  const family = brand.fonts.display || brand.fonts.body;
  const parse = async (buf, source, fam = family) => {
    let b = buf;
    if (b.subarray(0, 4).toString("latin1") === "wOF2") {
      try { const w = io.wawoff2 || (await import("wawoff2")).default; b = Buffer.from(await w.decompress(b)); } catch { return null; }
    }
    try {
      const font = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      return { font, source, family: font.getEnglishName?.("fontFamily") || fam };
    } catch { return null; }
  };
  if (brand.fontFile) {
    const f = path.resolve(dir, brand.fontFile);
    if (existsSync(f)) return parse(await readFile(f), brand.fontFile, path.basename(f).replace(/\.\w+$/, ""));
  }
  if (!family) return null;
  const faces = site.fontFaces.filter((f) => f.family.toLowerCase() === family.toLowerCase() && f.style === "normal")
    .sort((a, b) => Math.abs(a.weight - 600) - Math.abs(b.weight - 600));
  for (const face of faces) {
    for (const src of face.srcs) {
      if (!isLocal(src)) continue;
      const f = localPath(dir, site.base, src);
      if (f && existsSync(f)) { const r = await parse(await readFile(f), "the site's own font file"); if (r) return r; }
    }
  }
  const usesGoogle = site.googleFonts.some((u) => new RegExp(`family=${family.replace(/\s+/g, "(\\+|%20| )")}\\b`, "i").test(u));
  if (usesGoogle && !offline) {
    const fetchImpl = io.fetch || fetch;
    const q = family.replace(/\s+/g, "+");
    for (const url of [`https://fonts.googleapis.com/css2?family=${q}:wght@600`, `https://fonts.googleapis.com/css2?family=${q}`]) {
      try {
        // A plain user agent makes Google Fonts serve TrueType, which opentype.js reads directly.
        const css = await (await fetchImpl(url, { headers: { "User-Agent": "curl/8.5.0" } })).text();
        const src = css.match(/url\(([^)]+)\)/)?.[1];
        if (!src) continue;
        const res = await fetchImpl(src.replace(/["']/g, ""));
        if (!res.ok) continue;
        const r = await parse(Buffer.from(await res.arrayBuffer()), "Google Fonts");
        if (r) return r;
      } catch { /* try the next URL */ }
    }
  }
  return null;
}

/* ---------- Small helpers ---------- */

function parseArgs(argv) {
  const positional = [], flags = new Set(), values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.includes("=")) { const [k, ...v] = a.split("="); values[k] = v.join("="); continue; }
    if (a in VALUE_FLAGS) { values[a] = argv[++i] ?? ""; continue; }
    if (a.startsWith("--")) flags.add(a); else positional.push(a);
  }
  return { positional, flags, values };
}
function setPath(obj, key, value) {
  const parts = key.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] = o[p] && typeof o[p] === "object" ? o[p] : {};
  o[parts.at(-1)] = value;
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; }
}
async function loadModule(name, install) {
  try { return (await import(name)).default; }
  catch { throw new Error(`This tool needs "${name}". Run: npm install --no-save ${install} opentype.js wawoff2`); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run(process.argv.slice(2)).catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
}
