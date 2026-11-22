#!/usr/bin/env node
/* Load a shop's products, shipping rates, coupons and tax rates from an Excel workbook into Stripe.
 *
 *   npm install https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz    (once; the npm registry copy is outdated)
 *   node stripe-setup.mjs --template shop-data.xlsx     write a blank workbook with example rows
 *   STRIPE_SECRET_KEY=sk_test_… node stripe-setup.mjs shop-data.xlsx --dry-run   show what would change
 *   STRIPE_SECRET_KEY=sk_test_… node stripe-setup.mjs shop-data.xlsx             apply in TEST mode
 *   STRIPE_SECRET_KEY=sk_live_… node stripe-setup.mjs shop-data.xlsx --live      apply in LIVE mode (go-live day)
 *
 * Safe to run again: products are matched by their "key", shipping and tax rates by name, coupons by code.
 * A changed price becomes a new default price (the old one is archived); nothing is deleted.
 * The key needs write access to Products, Prices, Shipping rates, Coupons, Promotion codes and Tax rates.
 * Keep this key on your own computer. The website uses a separate read-mostly restricted key.
 *
 * Sheets (header row first; names are case-insensitive):
 *   Settings  setting | value        currency (usd), tax_behavior (exclusive | inclusive | unspecified),
 *                                    site_url (turns image paths like images/pint.webp into full URLs),
 *                                    tax_mode (none | stripe_tax | rates)
 *   Products  key | name | price | description | image | category | group | badge | sort | unit_label | tax_code | active
 *   Shipping  name | price | min_days | max_days | active
 *   Coupons   code | percent_off | amount_off | name | max_redemptions | expires | min_order | first_order_only
 *   Tax       name | percent | inclusive | country | state | description          (only for tax_mode "rates")
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STRIPE_VERSION = "2024-06-20";
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const SHIPPING_TAX_CODE = "txcd_92010001";

export async function run(argv, env = process.env, io = {}) {
  const log = io.log || console.log;
  const fetchImpl = io.fetch || fetch;
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const files = argv.filter((a) => !a.startsWith("--"));
  const XLSX = io.xlsx || (await loadXlsx());

  if (flags.has("--template")) {
    const out = files[0] || "shop-data.xlsx";
    writeTemplate(XLSX, out);
    log(`Wrote ${out}. Fill it in, then run: node stripe-setup.mjs ${out} --dry-run`);
    return { template: out };
  }
  if (!files[0]) throw new Error("Usage: node stripe-setup.mjs <workbook.xlsx> [--dry-run] [--live] [--archive-missing]");

  const key = env.STRIPE_SECRET_KEY || "";
  if (!/^(sk|rk)_(test|live)_/.test(key)) throw new Error("Set STRIPE_SECRET_KEY to a secret (sk_…) or restricted (rk_…) key.");
  const live = /_live_/.test(key);
  if (live && !flags.has("--live")) throw new Error("That is a LIVE key. Set the shop up in test mode first; add --live only on go-live day.");
  const dry = flags.has("--dry-run");
  const archiveMissing = flags.has("--archive-missing");

  const book = readBook(XLSX, await readFile(files[0]), files[0]);
  const settings = readSettings(book.settings);
  const plan = {
    products: readProducts(book.products, settings),
    shipping: readShipping(book.shipping, settings),
    coupons: readCoupons(book.coupons, settings),
    taxes: settings.tax_mode === "rates" ? readTaxes(book.tax) : [],
  };

  const api = makeApi(key, fetchImpl, dry, log);
  log(`${dry ? "DRY RUN — nothing will be changed. " : ""}Stripe ${live ? "LIVE" : "test"} mode, currency ${settings.currency.toUpperCase()}.`);
  const report = {
    products: await syncProducts(api, plan.products, settings, archiveMissing, log),
    shipping: await syncShipping(api, plan.shipping, settings, log),
    coupons: await syncCoupons(api, plan.coupons, settings, log),
    taxes: await syncTaxes(api, plan.taxes, log),
  };
  log(dry ? "Dry run finished. Run again without --dry-run to apply." : "Done. Check the Stripe Dashboard (Product catalog).");
  return report;
}

/* ---------- Workbook ---------- */

async function loadXlsx() {
  try { return await import("xlsx"); }
  catch { throw new Error('This script needs the "xlsx" package. Run: npm install https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz'); }
}

function readBook(XLSX, buffer, name) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheets = {};
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "", raw: true });
    sheets[sheetName.trim().toLowerCase()] = rows.map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) out[String(k).trim().toLowerCase().replace(/[\s-]+/g, "_")] = typeof v === "string" ? v.trim() : v;
      return out;
    }).filter((row) => Object.values(row).some((v) => v !== ""));
  }
  if (/\.csv$/i.test(name)) return { products: Object.values(sheets)[0] || [] };
  return { settings: sheets.settings, products: sheets.products, shipping: sheets.shipping, coupons: sheets.coupons, tax: sheets.tax || sheets.taxes };
}

function readSettings(rows = []) {
  const s = { currency: "usd", tax_behavior: "exclusive", site_url: "", tax_mode: "none" };
  for (const r of rows) {
    const k = String(r.setting || "").trim().toLowerCase().replace(/\s+/g, "_");
    if (k) s[k] = String(r.value ?? "").trim();
  }
  s.currency = s.currency.toLowerCase();
  s.tax_behavior = s.tax_behavior.toLowerCase();
  s.tax_mode = s.tax_mode.toLowerCase();
  s.site_url = s.site_url.replace(/\/+$/, "");
  if (!/^[a-z]{3}$/.test(s.currency)) throw new Error(`Settings: currency "${s.currency}" should be a 3-letter code like usd or eur.`);
  if (!["exclusive", "inclusive", "unspecified"].includes(s.tax_behavior)) throw new Error("Settings: tax_behavior must be exclusive, inclusive or unspecified.");
  if (!["none", "stripe_tax", "rates"].includes(s.tax_mode)) throw new Error("Settings: tax_mode must be none, stripe_tax or rates.");
  return s;
}

function readProducts(rows = [], s) {
  const seen = new Set();
  return rows.map((r, i) => {
    const where = `Products row ${i + 2}`;
    const key = String(r.key || "").trim();
    if (!key) throw new Error(`${where}: key is empty.`);
    if (seen.has(key)) throw new Error(`${where}: key "${key}" is used twice.`);
    seen.add(key);
    if (!r.name) throw new Error(`${where}: name is empty.`);
    return {
      key, name: String(r.name), description: String(r.description || ""),
      amount: toMinor(r.price, s.currency, where),
      images: String(r.image || r.images || "").split("|").map((x) => x.trim()).filter(Boolean).map((x) => absoluteUrl(x, s.site_url, where)),
      category: String(r.category || ""), group: String(r.group || ""), badge: String(r.badge || ""),
      sort: r.sort === "" || r.sort == null ? String(i + 1) : String(r.sort),
      unit_label: String(r.unit_label || ""), tax_code: String(r.tax_code || ""),
      active: yes(r.active, true),
    };
  });
}

function readShipping(rows = [], s) {
  return rows.map((r, i) => {
    const where = `Shipping row ${i + 2}`;
    if (!r.name) throw new Error(`${where}: name is empty.`);
    return {
      name: String(r.name), amount: toMinor(r.price, s.currency, where),
      min: r.min_days === "" ? null : int(r.min_days, where), max: r.max_days === "" ? null : int(r.max_days, where),
      active: yes(r.active, true),
    };
  });
}

function readCoupons(rows = [], s) {
  return rows.map((r, i) => {
    const where = `Coupons row ${i + 2}`;
    const code = String(r.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new Error(`${where}: code "${code}" should be 3–40 letters, digits, - or _.`);
    const pct = r.percent_off === "" ? null : Number(String(r.percent_off).replace("%", ""));
    const amt = r.amount_off === "" ? null : toMinor(r.amount_off, s.currency, where);
    if ((pct == null) === (amt == null)) throw new Error(`${where}: fill in exactly one of percent_off or amount_off.`);
    if (pct != null && !(pct > 0 && pct <= 100)) throw new Error(`${where}: percent_off must be between 0 and 100.`);
    return {
      code, name: String(r.name || code), percent_off: pct, amount_off: amt,
      max_redemptions: r.max_redemptions === "" ? null : int(r.max_redemptions, where),
      expires: r.expires === "" ? null : toEpoch(r.expires, where),
      min_order: r.min_order === "" ? null : toMinor(r.min_order, s.currency, where),
      first_order_only: yes(r.first_order_only, false),
    };
  });
}

function readTaxes(rows = []) {
  return rows.map((r, i) => {
    const where = `Tax row ${i + 2}`;
    const percent = Number(String(r.percent).replace("%", ""));
    if (!r.name || !(percent >= 0 && percent <= 100)) throw new Error(`${where}: needs a name and a percent from 0 to 100.`);
    return { name: String(r.name), percent, inclusive: yes(r.inclusive, false), country: String(r.country || "").toUpperCase(),
      state: String(r.state || "").toUpperCase(), description: String(r.description || "") };
  });
}

/* ---------- Sync ---------- */

async function syncProducts(api, wanted, s, archiveMissing, log) {
  const existing = await api.list("products", { expand: ["data.default_price"] });
  const byKey = new Map();
  for (const p of existing) if (p.metadata?.key) byKey.set(p.metadata.key, p);
  const report = [];
  for (const w of wanted) {
    const meta = { key: w.key, category: w.category, group: w.group, badge: w.badge, sort: w.sort, shop: "yes" };
    const fields = { name: w.name, description: w.description, images: w.images.length ? w.images : "",
      unit_label: w.unit_label, active: w.active, metadata: meta, ...(w.tax_code ? { tax_code: w.tax_code } : {}) };
    const cur = byKey.get(w.key);
    if (!cur) {
      // Stripe rejects empty strings on create (they mean "unset"), so leave blank fields out.
      const created = await api.post("products", { ...prune(fields), default_price_data: priceData(w.amount, s) }, `create product ${w.key} (${money(w.amount, s.currency)})`);
      report.push({ key: w.key, action: "created", id: created.id });
      continue;
    }
    const changes = [];
    if (cur.name !== w.name) changes.push("name");
    if ((cur.description || "") !== w.description) changes.push("description");
    if (JSON.stringify(cur.images || []) !== JSON.stringify(w.images)) changes.push("images");
    if ((cur.unit_label || "") !== w.unit_label) changes.push("unit label");
    if (cur.active !== w.active) changes.push(w.active ? "reactivate" : "archive");
    for (const [k, v] of Object.entries(meta)) if ((cur.metadata?.[k] || "") !== v) { changes.push("metadata"); break; }
    const p = cur.default_price && typeof cur.default_price === "object" ? cur.default_price : null;
    const priceChanged = !p || !p.active || p.unit_amount !== w.amount || p.currency !== s.currency
      || (s.tax_behavior !== "unspecified" && p.tax_behavior !== s.tax_behavior);
    if (changes.length) {
      const body = { ...fields };
      if (!w.unit_label) body.unit_label = "";
      if (!w.description) body.description = "";
      await api.post(`products/${cur.id}`, body, `update product ${w.key}: ${[...new Set(changes)].join(", ")}`);
    }
    if (priceChanged) {
      const np = await api.post("prices", { product: cur.id, ...priceData(w.amount, s) },
        `new price for ${w.key}: ${p ? money(p.unit_amount, p.currency) + " → " : ""}${money(w.amount, s.currency)}`);
      await api.post(`products/${cur.id}`, { default_price: np.id }, `make it the default price for ${w.key}`);
      if (p && p.active) await api.post(`prices/${p.id}`, { active: false }, `archive old price for ${w.key}`);
    }
    report.push({ key: w.key, action: changes.length || priceChanged ? "updated" : "unchanged", id: cur.id });
  }
  const wantedKeys = new Set(wanted.map((w) => w.key));
  for (const [key, p] of byKey) {
    if (wantedKeys.has(key) || !p.active) continue;
    if (archiveMissing) {
      await api.post(`products/${p.id}`, { active: false }, `archive product ${key} (not in the workbook)`);
      report.push({ key, action: "archived", id: p.id });
    } else {
      log(`  note: product "${key}" is in Stripe but not in the workbook (left as is; --archive-missing archives it)`);
    }
  }
  return report;
}

async function syncShipping(api, wanted, s, log) {
  if (!wanted.length) return [];
  const existing = await api.list("shipping_rates", {});
  const report = [];
  for (const w of wanted) {
    const same = existing.filter((r) => r.display_name?.toLowerCase() === w.name.toLowerCase());
    const match = same.find((r) => r.fixed_amount?.amount === w.amount && r.fixed_amount?.currency === s.currency
      && (r.delivery_estimate?.minimum?.value ?? null) === w.min && (r.delivery_estimate?.maximum?.value ?? null) === w.max);
    if (match) {
      if (match.active !== w.active) await api.post(`shipping_rates/${match.id}`, { active: w.active }, `${w.active ? "reactivate" : "archive"} shipping rate ${w.name}`);
      report.push({ name: w.name, action: match.active !== w.active ? "updated" : "unchanged", id: match.id });
    } else {
      const estimate = {};
      if (w.min != null) estimate.minimum = { unit: "business_day", value: w.min };
      if (w.max != null) estimate.maximum = { unit: "business_day", value: w.max };
      const created = await api.post("shipping_rates", {
        display_name: w.name, type: "fixed_amount", fixed_amount: { amount: w.amount, currency: s.currency },
        ...(Object.keys(estimate).length ? { delivery_estimate: estimate } : {}),
        tax_behavior: s.tax_behavior, ...(s.tax_mode === "stripe_tax" ? { tax_code: SHIPPING_TAX_CODE } : {}),
        metadata: { shop: "yes" },
      }, `create shipping rate ${w.name} (${money(w.amount, s.currency)})`);
      report.push({ name: w.name, action: "created", id: created.id });
    }
    for (const old of same) {
      if (old.active && old.id !== match?.id) await api.post(`shipping_rates/${old.id}`, { active: false }, `archive old shipping rate ${old.display_name}`);
    }
  }
  return report;
}

async function syncCoupons(api, wanted, s, log) {
  const report = [];
  for (const w of wanted) {
    const found = await api.list("promotion_codes", { code: w.code });
    if (found.some((pc) => pc.active)) {
      log(`  note: code ${w.code} already exists (codes can't be edited; archive it in Stripe and rename to change it)`);
      report.push({ code: w.code, action: "unchanged" });
      continue;
    }
    const coupon = await api.post("coupons", {
      name: w.name, duration: "once",
      ...(w.percent_off != null ? { percent_off: w.percent_off } : { amount_off: w.amount_off, currency: s.currency }),
    }, `create coupon ${w.name} (${w.percent_off != null ? w.percent_off + "%" : money(w.amount_off, s.currency)} off)`);
    const restrictions = {};
    if (w.min_order != null) { restrictions.minimum_amount = w.min_order; restrictions.minimum_amount_currency = s.currency; }
    if (w.first_order_only) restrictions.first_time_transaction = true;
    const pc = await api.post("promotion_codes", {
      coupon: coupon.id, code: w.code,
      ...(w.max_redemptions != null ? { max_redemptions: w.max_redemptions } : {}),
      ...(w.expires != null ? { expires_at: w.expires } : {}),
      ...(Object.keys(restrictions).length ? { restrictions } : {}),
    }, `create promotion code ${w.code}`);
    report.push({ code: w.code, action: "created", id: pc.id });
  }
  return report;
}

async function syncTaxes(api, wanted, log) {
  if (!wanted.length) return [];
  const existing = await api.list("tax_rates", {});
  const report = [];
  for (const w of wanted) {
    const same = existing.filter((t) => t.display_name?.toLowerCase() === w.name.toLowerCase()
      && (t.country || "") === w.country && (t.state || "") === w.state);
    const match = same.find((t) => t.percentage === w.percent && t.inclusive === w.inclusive && t.active);
    if (match) { report.push({ name: w.name, action: "unchanged", id: match.id }); continue; }
    const created = await api.post("tax_rates", {
      display_name: w.name, percentage: w.percent, inclusive: w.inclusive,
      ...(w.country ? { country: w.country } : {}), ...(w.state ? { state: w.state } : {}),
      ...(w.description ? { description: w.description } : {}), metadata: { shop: "yes" },
    }, `create tax rate ${w.name} ${w.percent}%${w.inclusive ? " (included in prices)" : ""}`);
    for (const old of same) if (old.active) await api.post(`tax_rates/${old.id}`, { active: false }, `archive old tax rate ${old.display_name} ${old.percentage}%`);
    report.push({ name: w.name, action: "created", id: created.id });
  }
  return report;
}

/* ---------- Stripe API ---------- */

function makeApi(key, fetchImpl, dry, log) {
  let fake = 0;
  async function call(method, path, params) {
    const form = params ? encodeForm(params) : "";
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}${method === "GET" && form ? "?" + form : ""}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION,
        ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) },
      body: method === "GET" ? undefined : form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Stripe ${method} /${path}: ${data.error?.message || "HTTP " + res.status}`);
    return data;
  }
  return {
    async list(path, params) {
      const out = [];
      let after;
      for (let i = 0; i < 50; i++) {
        const res = await call("GET", path, { ...params, limit: 100, starting_after: after });
        out.push(...res.data);
        if (!res.has_more || !res.data.length) break;
        after = res.data[res.data.length - 1].id;
      }
      return out;
    },
    async post(path, params, what) {
      log(`  ${dry ? "would " : ""}${what}`);
      if (dry) return { id: `dry_${++fake}` };
      return call("POST", path, params);
    },
  };
}

export function encodeForm(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}

/* ---------- Helpers ---------- */

function priceData(amount, s) {
  return { currency: s.currency, unit_amount: amount, ...(s.tax_behavior !== "unspecified" ? { tax_behavior: s.tax_behavior } : {}) };
}

function toMinor(value, currency, where) {
  let t = String(value ?? "").replace(/[^\d.,-]/g, "");
  if (t.includes(",") && !t.includes(".")) t = t.replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  if (t === "" || !Number.isFinite(n) || n < 0) throw new Error(`${where}: "${value}" isn't a price.`);
  return ZERO_DECIMAL.has(currency) ? Math.round(n) : Math.round(n * 100);
}

function money(minor, currency) {
  const n = ZERO_DECIMAL.has(currency) ? minor : minor / 100;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(n); }
  catch { return `${n} ${currency}`; }
}

function absoluteUrl(path, site, where) {
  if (/^https:\/\//i.test(path)) return path;
  if (!site) throw new Error(`${where}: image "${path}" needs a full https:// URL, or set site_url in Settings.`);
  return `${site}/${path.replace(/^\/+/, "")}`;
}

function toEpoch(v, where) {
  const d = typeof v === "number" ? new Date(Math.round((v - 25569) * 86400000)) : new Date(String(v) + "T23:59:59Z");
  if (Number.isNaN(d.getTime())) throw new Error(`${where}: "${v}" isn't a date (use YYYY-MM-DD).`);
  if (typeof v === "number") d.setUTCHours(23, 59, 59);
  if (d.getTime() < Date.now()) throw new Error(`${where}: expiry date ${d.toISOString().slice(0, 10)} is in the past.`);
  return Math.floor(d.getTime() / 1000);
}

function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === "" || v === undefined || v === null) continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? prune(v) : v;
  }
  return out;
}

const int = (v, where) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`${where}: "${v}" should be a whole number.`); return n; };
const yes = (v, dflt) => (v === "" || v == null ? dflt : /^(y|yes|true|1|x)$/i.test(String(v).trim()));

function writeTemplate(XLSX, out) {
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  add("Settings", [["setting", "value", "notes"],
    ["currency", "usd", "3-letter code; every price uses it"],
    ["tax_behavior", "exclusive", "exclusive = tax added at checkout; inclusive = prices already include tax. Can't be changed later per price."],
    ["tax_mode", "none", "none | stripe_tax | rates"],
    ["site_url", "https://example.pages.dev", "used to turn image paths into full URLs"]]);
  add("Products", [["key", "name", "price", "description", "image", "category", "group", "badge", "sort", "unit_label", "tax_code", "active"],
    ["pint", "Pint", 6.75, "16 oz container", "images/pint.webp", "Ice cream", "", "", 1, "", "", "yes"],
    ["quart", "Quart", 13.25, "32 oz container", "images/quart.webp", "Ice cream", "", "", 2, "", "", "yes"]]);
  add("Shipping", [["name", "price", "min_days", "max_days", "active"],
    ["Local delivery", 0, 1, 3, "yes"], ["Standard shipping", 12.5, 3, 5, "yes"]]);
  add("Coupons", [["code", "percent_off", "amount_off", "name", "max_redemptions", "expires", "min_order", "first_order_only"],
    ["WELCOME10", 10, "", "10% off your first order", "", "", "", "yes"]]);
  add("Tax", [["name", "percent", "inclusive", "country", "state", "description"],
    ["Sales tax", 8.5, "no", "US", "WA", "Only used when tax_mode is rates"]]);
  XLSX.writeFile(wb, out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((err) => { console.error("Error: " + err.message); process.exit(1); });
}
