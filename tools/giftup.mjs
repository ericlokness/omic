#!/usr/bin/env node
/* Brand the client's Gift Up account from brand.json and images/brand/* (made by tools/brand.mjs).
 *
 *   GIFTUP_API_KEY=… node tools/giftup.mjs check [site]           account, Stripe connection, designs, items, expiry
 *   GIFTUP_API_KEY=… node tools/giftup.mjs brand [site] --dry-run show what would change
 *   GIFTUP_API_KEY=… node tools/giftup.mjs brand [site]           checkout colours and font, email logo and button,
 *                                                                 gift card design
 *     --all-designs            upload gift-card-2.png too, so buyers can choose
 *     --replace-all-artwork    make these the only designs (deletes every other design in Gift Up)
 *   GIFTUP_API_KEY=… node tools/giftup.mjs expiry never|<months> [site]   gift card expiry (the client decides)
 *
 * The API key is made in Gift Up → Integrations → API keys (giftup.app/integrations/api-keys). Keep it on this
 * computer; the website never needs it (the checkout embed only uses the public Gift Up ID).
 * Settings and designs are account-wide, so they apply in Gift Up's test mode and live mode alike.
 * Running it again is safe: our designs are replaced in place, not added twice.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.giftup.app";

export async function run(argv, env = process.env, io = {}) {
  const log = io.log || console.log;
  const fetchImpl = io.fetch || fetch;
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [command, ...rest] = argv.filter((a) => !a.startsWith("--"));
  const dry = flags.has("--dry-run");
  const key = env.GIFTUP_API_KEY || "";
  if (!command || !["check", "brand", "expiry"].includes(command)) {
    throw new Error("Usage: node tools/giftup.mjs check|brand|expiry [never|<months>] [site-folder] [--dry-run]");
  }
  if (!key && !dry) throw new Error("Set GIFTUP_API_KEY (Gift Up → Integrations → API keys). Keep it out of the repo and the chat.");
  const api = makeApi(env.GIFTUP_API_BASE || API, key, fetchImpl);

  if (command === "check") return check(api, log);
  if (command === "expiry") return expiry(api, rest[0], dry, log);

  const dir = path.resolve(rest[0] || ".");
  const jsonPath = path.join(dir, "brand.json");
  if (!existsSync(jsonPath)) throw new Error(`No brand.json in ${dir}. Run node tools/brand.mjs first.`);
  const brand = JSON.parse(await readFile(jsonPath, "utf8"));
  const report = await applyBrand(api, brand, dir, { dry, all: flags.has("--all-designs"), replaceAll: flags.has("--replace-all-artwork"), log });
  if (!dry) await writeFile(jsonPath, JSON.stringify(brand, null, 2) + "\n");
  return report;
}

/* ---------- Commands ---------- */

async function check(api, log) {
  const out = {};
  out.ping = await api("GET", "/ping").catch((e) => `failed: ${e.message}`);
  if (typeof out.ping === "string" && out.ping.startsWith("failed")) { log(`Gift Up API: ${out.ping}`); return out; }
  out.company = await api("GET", "/company").catch(() => null);
  out.stripe = await api("GET", "/integrations/stripe/connection").catch(() => null);
  out.artwork = await api("GET", "/settings/gift-card/artwork").catch(() => []);
  out.items = await api("GET", "/items").catch(() => []);
  out.giftCard = await api("GET", "/settings/gift-card").catch(() => null);
  log(`Gift Up account: ${out.company?.name || out.company?.companyName || "(name not returned)"}`);
  log(`Stripe Checkout connection (gift cards as Stripe promotion codes): ${JSON.stringify(redact(out.stripe))}`);
  log(`Designs: ${out.artwork.length}${out.artwork.length ? " — " + out.artwork.map((a) => a.id).join(", ") : ""}`);
  log(`Items for sale: ${out.items.length ? out.items.map((i) => `${i.name}${i.price != null ? ` (${i.price})` : ""}`).join(", ") : "none yet; add them in Gift Up → Items"}`);
  if (out.giftCard) {
    const e = out.giftCard.expiryInMonths ?? out.giftCard.expiryinmonths, d = out.giftCard.expiryInDays ?? out.giftCard.expiryindays;
    log(`Expiry: ${e ? `${e} months` : d ? `${d} days` : "never"}`);
  }
  return out;
}

async function expiry(api, value, dry, log) {
  if (!value) throw new Error('Say "never" or a number of months, e.g. node tools/giftup.mjs expiry never');
  const months = value === "never" ? null : parseInt(value, 10);
  if (value !== "never" && !(months >= 1)) throw new Error('Expiry must be "never" or a whole number of months (1 or more).');
  const ops = [{ op: "replace", path: "/expiryinmonths", value: months }, { op: "replace", path: "/expiryindays", value: null }];
  if (dry) { log(`DRY RUN: gift card expiry → ${months ? `${months} months` : "never"}`); return { ops }; }
  await api("PATCH", "/settings/gift-card", ops);
  log(`Gift card expiry set to ${months ? `${months} months after purchase` : "never"}. It applies to cards sold from now on.`);
  return { ops };
}

export async function applyBrand(api, brand, dir, { dry, all, replaceAll, log }) {
  const c = brand.colors || {};
  const imgs = brand.images || {};
  const dataUri = async (rel) => (rel && existsSync(path.join(dir, rel)) ? `data:image/png;base64,${(await readFile(path.join(dir, rel))).toString("base64")}` : null);
  const textOn = (bg) => (luminance(bg) > 0.4 ? "#111111" : "#ffffff");
  const report = { checkout: null, email: null, artwork: [], skipped: [] };

  const checkout = [
    ["/themecolor", c.accent],
    ["/backgroundcolor", c.background],
    ["/fontfamily", brand.fonts?.body],
    ["/hostedbackgroundcolor", c.brand],
    ["/hostedtextcolor", c.brand && textOn(c.brand)],
    ["/logourl", await dataUri(imgs.checkoutLogo)],
  ];
  const email = [
    ["/logourl", await dataUri(imgs.emailLogo)],
    ["/logoalignment", "middle"],
    ["/logowidth", 240],
    ["/fromname", brand.name],
    ["/giftcardemail/buttoncolour", c.accent],
  ];
  const ops = (pairs) => pairs.filter(([, v]) => v != null && v !== "").map(([p, value]) => ({ op: "replace", path: p, value }));
  const show = (o) => `${o.path} = ${String(o.value).startsWith("data:") ? "(image)" : o.value}`;
  const designs = (imgs.giftCards || []).slice(0, all ? undefined : 1).filter((f) => existsSync(path.join(dir, f)));
  if (!designs.length) throw new Error("No gift card design in brand.json. Run node tools/brand.mjs first.");

  if (dry) {
    log("DRY RUN — nothing will be changed in Gift Up.");
    log(`Checkout settings: ${ops(checkout).map(show).join("; ")}`);
    log(`Email settings: ${ops(email).map(show).join("; ")}`);
    log(`Designs: ${designs.join(", ")}${replaceAll ? " (replacing every existing design)" : ""}`);
    return { checkout: ops(checkout), email: ops(email), artwork: designs };
  }

  report.checkout = await patch(api, "/settings/checkout", ops(checkout), report.skipped);
  report.email = await patch(api, "/settings/email", ops(email), report.skipped);
  log(`Checkout and email settings updated${report.skipped.length ? `; Gift Up refused ${report.skipped.join(", ")} (set it in Gift Up → Settings)` : ""}.`);

  brand.giftup = brand.giftup || {};
  const ours = (brand.giftup.artwork = brand.giftup.artwork || {});
  let list = await api("GET", "/settings/gift-card/artwork");
  for (const [i, file] of designs.entries()) {
    const before = new Set(list.map((a) => a.id));
    const body = { url: await dataUri(file) };
    if (replaceAll && i === 0) body.replaceAllExistingArtwork = true;
    else if (ours[file] && before.has(ours[file])) body.replaceArtworkId = ours[file];
    try {
      await api("POST", "/settings/gift-card/artwork", body);
    } catch (e) {
      // The docs say "url" takes a data:image string; if this account wants a link instead, use the deployed copy.
      if (!brand.siteUrl || !(e.status >= 400 && e.status < 500)) throw e;
      body.url = new URL(file, brand.siteUrl.endsWith("/") ? brand.siteUrl : brand.siteUrl + "/").href;
      await api("POST", "/settings/gift-card/artwork", body);
    }
    list = await api("GET", "/settings/gift-card/artwork");
    const added = list.find((a) => !before.has(a.id));
    if (added) ours[file] = added.id;
    else if (!body.replaceArtworkId) ours[file] = list.at(-1)?.id;
    report.artwork.push({ file, id: ours[file], replaced: !!body.replaceArtworkId });
    log(`Design ${file} ${body.replaceArtworkId ? "replaced" : "uploaded"}${ours[file] ? ` (${ours[file]})` : ""}.`);
  }
  const mine = new Set(Object.values(ours));
  const others = list.filter((a) => !mine.has(a.id));
  if (others.length) {
    log(`${others.length} other design(s) are still in Gift Up, so buyers can pick them. Remove them in Gift Up → Settings → Gift cards, or run again with --replace-all-artwork.`);
  }
  const first = [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0];
  if (first && !mine.has(first.id)) log("Note: another design is still first (the default). Drag ours to the top in Gift Up → Settings → Gift cards.");
  report.others = others.length;
  return report;
}

/* PATCH with JSON Patch; if Gift Up rejects the batch, apply operations one by one and note which it refused. */
async function patch(api, url, ops, skipped) {
  if (!ops.length) return [];
  try { await api("PATCH", url, ops); return ops; }
  catch (e) {
    if (!(e.status >= 400 && e.status < 500)) throw e;
    const done = [];
    for (const op of ops) {
      try { await api("PATCH", url, [op]); done.push(op); }
      catch (e2) { if (!(e2.status >= 400 && e2.status < 500)) throw e2; skipped.push(`${url.split("/").pop()} ${op.path.slice(1)}`); }
    }
    return done;
  }
}

/* ---------- Helpers ---------- */

function makeApi(base, key, fetchImpl) {
  return async (method, url, body) => {
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = method === "PATCH" ? "application/json-patch+json" : "application/json";
    const res = await fetchImpl(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* plain text, e.g. "pong" */ }
    if (!res.ok) {
      const msg = typeof data === "object" && data ? data.message || data.error || data.title || JSON.stringify(data) : text;
      const err = new Error(`Gift Up ${method} ${url}: ${res.status} ${String(msg).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) out[k] = /key|secret|token|password/i.test(k) ? (v ? "(set)" : v) : typeof v === "object" ? redact(v) : v;
  return out;
}

function luminance(hex) {
  const n = parseInt(String(hex).replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run(process.argv.slice(2)).catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
}
