/* Stripe shop API for a static site on Cloudflare (Pages Functions or a Worker).
 *
 *   GET  /api/catalog                       active products + current prices (public fields only)
 *   POST /api/checkout                      { lines:[{product, qty, options, custom}], details:{…} }
 *                                           -> { clientSecret, publishableKey } (embedded) or { url } (hosted)
 *   GET  /api/order?session_id=cs_…         { paid, free, pending, status, amount_total, currency } for the thank-you page
 *
 * Secret: STRIPE_SECRET_KEY = a RESTRICTED key (rk_test_… / rk_live_…) with
 *   Products: Read · Prices: Read · Shipping rates: Read · Tax rates: Read · Checkout Sessions: Write.
 * Variable: STRIPE_PUBLISHABLE_KEY = pk_test_… / pk_live_… (public; the page needs it to show the embedded
 *   payment form). Without it, or if it doesn't match the secret key's mode, checkout uses Stripe's hosted page.
 * Set them with wrangler, never in this file. The site sends product KEYS and quantities only;
 * Stripe decides every amount, so a visitor can't change a price.
 *
 * Product key = the product's metadata "key" in Stripe (same in test and live mode), else its id.
 * Price      = the product's DEFAULT price. To change a price in the Stripe Dashboard, add a new
 *              price to the product and make it the default. Changes show on the site within cacheSeconds.
 */
export const SHOP = {
  // Olympic Mountain Ice Cream: wholesale orders from wholesale.html (see PROJECT_HANDOFF.md, "Shop (Stripe)").
  currency: "usd",
  catalog: "tagged",             // only Stripe products with metadata shop=yes (the five sizes)
  maxQty: 99,                    // per cart line (the page allows 1–99)
  maxLines: 60,                  // per order
  options: {
    base:   { label: "Base", values: ["Ice cream", "Sorbet"], required: true },
    flavor: { label: "Flavor", required: true, maxLength: 80 },   // free text; the page sends custom: true for custom flavors
    // Wine/spirits surcharge (owner to decide): add addons: { "Champagne": "booze-{product}", … }
    // and Stripe products with keys booze-pint, booze-quart, booze-1.5, booze-3, booze-pan.
  },
  details: [
    { key: "business", label: "Business name", required: true, maxLength: 120 },
    { key: "contact", label: "Contact name", required: true, maxLength: 80 },
    { key: "phone", label: "Phone", required: true, maxLength: 40 },
    { key: "delivery_date", label: "Preferred delivery", maxLength: 20 },
    { key: "address", label: "Delivery address", required: true, maxLength: 200 },
    { key: "city", label: "City", required: true, maxLength: 80 },
    { key: "zip", label: "ZIP", required: true, maxLength: 10 },
    { key: "notes", label: "Notes", maxLength: 500 },
  ],
  deliveryState: "WA",           // every delivery is in Washington; the order form asks for street, city and ZIP
  shippingCountries: [],         // none: the order form asks for the delivery address once, so Stripe doesn't ask again.
                                 // (A delivery fee would then go in as a line item; Stripe shipping rates need this on.)
  shippingRates: "auto",         // active Stripe shipping rates (none yet: delivery fee still to decide)
  collectPhone: false,           // the order form already asks for a phone number
  promotionCodes: true,
  adaptivePricing: false,        // US-only wholesale: always show and charge USD (no converted local-currency prices)
  tax: "none",                   // no sales tax: packaged ice cream is exempt food in WA (owner's accountant to confirm)
  saveCustomers: true,
  checkoutUi: "embedded",        // Stripe's payment form shows inside wholesale.html (#pay), so buyers stay on this
                                 // domain. Needs STRIPE_PUBLISHABLE_KEY; without it checkout uses Stripe's hosted page.
  successPath: "/order-complete",
  cancelPath: "/wholesale#summary",   // hosted page only
  cacheSeconds: 300,
  // Look of the Stripe payment page (Checkout branding_settings), sent with every session so it
  // follows the site to any Stripe account. Logo and icon are site paths (PNG/JPG, Stripe's rule).
  // Fonts: Stripe's list only (Fraunces/Karla aren't offered); "lora" is the closest serif to Fraunces.
  branding: {
    display_name: "Olympic Mountain Ice Cream",
    background_color: "#0a1424",   // --midnight
    button_color: "#9e6a32",       // --btn: copper deep enough for white text (4.6:1)
    border_style: "pill",          // matches the site's pill buttons
    font_family: "lora",
    logo: "/images/logo-cream-v2.png",
    icon: "/images/checkout-icon.png",
  },
};

/* Cloudflare Pages Functions entry. A Worker calls handleShop() from its own fetch handler. */
export function onRequest(context) {
  return handleShop(context.request, context.env, context);
}

class ShopError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function handleShop(request, env, ctx) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, "");
  try {
    if (!env.STRIPE_SECRET_KEY) throw new ShopError("The shop isn't switched on yet.", 503);
    if (route === "/api/catalog" && request.method === "GET") {
      const cat = await loadCatalog(env, ctx, url.origin);
      return json({ mode: cat.mode, currency: SHOP.currency, products: cat.products.map(publicProduct) },
        200, { "Cache-Control": "public, max-age=60" });
    }
    if (route === "/api/checkout" && request.method === "POST") return await checkout(request, env, ctx, url.origin);
    if (route === "/api/order" && request.method === "GET") return await order(url, env);
    return json({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof ShopError) return json({ error: err.message }, err.status);
    console.error("shop error:", err.status || "", err.stripe?.code || "", err.message);
    const message = isTest(env) ? `Stripe (test mode): ${err.message}`
      : "Something went wrong starting checkout. Please try again, or contact us.";
    return json({ error: message }, 502);
  }
}

/* ---------- Checkout ---------- */

async function checkout(request, env, ctx, origin) {
  const from = request.headers.get("Origin");
  if (from && from !== origin) throw new ShopError("Checkout has to start on this website.", 403);
  if (Number(request.headers.get("Content-Length") || 0) > 65536) throw new ShopError("That order is too large.", 413);
  let body;
  try { body = await request.json(); } catch { throw new ShopError("Bad request."); }

  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (!lines.length) throw new ShopError("Your cart is empty.");
  if (lines.length > SHOP.maxLines) throw new ShopError(`Please split orders with more than ${SHOP.maxLines} lines.`);

  const cat = await loadCatalog(env, ctx, origin);
  const byKey = new Map(cat.products.map((p) => [p.key, p]));
  const qtyByPrice = new Map();   // add-ons (surcharges) only, by price
  const add = (priceId, qty) => qtyByPrice.set(priceId, (qtyByPrice.get(priceId) || 0) + qty);
  const cartLines = [];           // one Stripe line item per cart line (see the line_items note below)
  const summary = [];

  for (const line of lines) {
    const product = byKey.get(String(line?.product ?? ""));
    if (!product) throw new ShopError("Something in your cart is no longer available. Please refresh the page.", 409);
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > SHOP.maxQty) throw new ShopError(`Quantities must be from 1 to ${SHOP.maxQty}.`);
    const { text, addons, values } = readOptions(line.options, line.custom === true);
    cartLines.push({ product, qty, text, values });
    for (const addonKey of addons) {
      const extra = byKey.get(addonKey.replace("{product}", product.key));
      if (!extra) throw new ShopError("Part of this order can't be priced online. Please contact us to order it.", 409);
      add(extra.priceId, qty);
    }
    summary.push(`${qty} × ${product.name}${text ? " — " + text : ""}`);
  }

  const { fields, email } = readDetails(body.details);
  // Delivery address: street, city and ZIP from the order form. It goes on the payment as its SHIPPING address
  // (Stripe shows it under Shipping), and as one line in the metadata for the order email. It is never the card's
  // billing address: Stripe's form asks for that separately, and the card is checked against its own billing ZIP.
  const delivery = fields.address ? {
    line1: fields.address, city: fields.city || "", state: SHOP.deliveryState, postal_code: fields.zip || "", country: "US",
  } : null;
  if (delivery && !/^\d{5}(-\d{4})?$/.test(delivery.postal_code)) throw new ShopError("Please enter a 5-digit ZIP code.");
  if (delivery) {
    fields.address = `${delivery.line1}, ${delivery.city}, ${delivery.state} ${delivery.postal_code}`;
    delete fields.city;
    delete fields.zip;
  }
  // Order number, e.g. W261127-7K3Q (order date in Pacific time + 4 random characters): on the payment's metadata,
  // its description and client_reference_id, so it shows and is searchable in the Dashboard, the order email and the
  // thank-you page.
  const orderNumber = makeOrderNumber();
  const metadata = buildMetadata({ order_number: orderNumber, ...fields }, summary);
  const firstField = Object.values(fields)[0];
  const taxLine = SHOP.tax === "rates" && cat.taxRates.length
    ? (cat.taxRates.length === 1 ? { tax_rates: cat.taxRates } : { dynamic_tax_rates: cat.taxRates })
    : {};

  const embedded = useEmbedded(env);
  const returnTo = `${origin}${SHOP.successPath}?session_id={CHECKOUT_SESSION_ID}`;
  const params = {
    mode: "payment",
    // One line per cart line, named by flavor ("Madagascar Vanilla — 1.5 gallon tub", base underneath), so Stripe's
    // payment form, receipts and the Dashboard show what was ordered and how many. The amount is the size's current
    // catalog price, looked up here on the server, so a buyer still can't change a price. Stripe makes a hidden
    // product for each inline line; they don't appear in the product catalog (checked Nov 27, 2026).
    line_items: [
      ...cartLines.map(({ product, qty, text, values }) => ({
        quantity: qty,
        price_data: {
          currency: SHOP.currency,
          unit_amount: product.amount,
          ...(product.tax_behavior ? { tax_behavior: product.tax_behavior } : {}),
          product_data: {
            name: truncate(values.flavor ? `${values.flavor} — ${product.name}` : `${product.name}${text ? " — " + text : ""}`, 250),
            ...(values.flavor && values.base ? { description: values.base } : {}),
            metadata: {
              size_key: product.key, size_price: product.priceId,
              ...(product.productId ? { size_product: product.productId } : {}),
            },
          },
        },
        ...taxLine,
      })),
      ...[...qtyByPrice].map(([price, quantity]) => ({ price, quantity, ...taxLine })),
    ],
    ...(embedded
      ? { ui_mode: embeddedMode, return_url: returnTo }
      : { success_url: returnTo, cancel_url: `${origin}${SHOP.cancelPath}` }),
    metadata,
    client_reference_id: orderNumber,
    payment_intent_data: {
      description: truncate(`Order ${orderNumber}${firstField ? " — " + firstField : ""} (${summary.length} line${summary.length === 1 ? "" : "s"})`, 300),
      metadata,
      ...(delivery ? { shipping: { name: fields.business || fields.contact || "Wholesale customer", ...(fields.phone ? { phone: fields.phone } : {}), address: delivery } } : {}),
    },
    custom_text: { submit: { message: truncate("Your order: " + summary.join("; "), 1200) } },
  };
  if (SHOP.branding) params.branding_settings = brandingSettings(origin, embedded);
  if (typeof SHOP.adaptivePricing === "boolean") params.adaptive_pricing = { enabled: SHOP.adaptivePricing };
  if (SHOP.promotionCodes) params.allow_promotion_codes = true;
  if (SHOP.collectPhone) params.phone_number_collection = { enabled: true };
  if (SHOP.saveCustomers) params.customer_creation = "always";
  if (email) params.customer_email = email;
  if (SHOP.tax === "stripe_tax") params.automatic_tax = { enabled: true };
  if (SHOP.shippingCountries.length) {
    params.shipping_address_collection = { allowed_countries: SHOP.shippingCountries };
    if (cat.shippingRates.length) params.shipping_options = cat.shippingRates.map((id) => ({ shipping_rate: id }));
  }

  const session = await createSession(env, params);
  if (embedded) {
    return json({ clientSecret: session.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY }, 200, { "Cache-Control": "no-store" });
  }
  return json({ url: session.url }, 200, { "Cache-Control": "no-store" });
}

/* Embedded checkout needs a publishable key of the same mode as the secret key; otherwise use the hosted page. */
function useEmbedded(env) {
  if (SHOP.checkoutUi !== "embedded") return false;
  const pk = env.STRIPE_PUBLISHABLE_KEY || "";
  if (!pk) return false;
  if (!/^pk_(test|live)_[A-Za-z0-9]+$/.test(pk) || /^pk_test_/.test(pk) !== isTest(env)) {
    console.warn("shop: STRIPE_PUBLISHABLE_KEY is not a publishable key of the same mode as STRIPE_SECRET_KEY; using hosted checkout");
    return false;
  }
  return true;
}

/* Stripe renamed ui_mode "embedded" to "embedded_page" in newer API versions. Start with the name the pinned
   STRIPE_VERSION (2024-06-20) knows, "embedded", and switch once (and remember it) if Stripe asks for the other. */
let embeddedMode = "embedded";
async function createSession(env, params) {
  try {
    return await stripe(env, "POST", "checkout/sessions", params);
  } catch (e) {
    // Only a complaint about the ui_mode value itself, not e.g. "You cannot set `logo` when `ui_mode` is `embedded`"
    const uiModeError = params.ui_mode && e.status === 400 &&
      (e.stripe?.param === "ui_mode" || /ui_mode value|invalid (value for )?ui_mode/i.test(e.message));
    if (!uiModeError) throw e;
    const other = params.ui_mode === "embedded_page" ? "embedded" : "embedded_page";
    const session = await stripe(env, "POST", "checkout/sessions", { ...params, ui_mode: other });
    embeddedMode = other;
    return session;
  }
}

/* SHOP.branding -> Checkout branding_settings; logo/icon site paths become absolute URLs on this host.
   Embedded checkout sits inside our own page, so Stripe refuses a logo or icon there ("You cannot set `logo`
   when `ui_mode` is `embedded`", seen Nov 26, 2026); it still takes the name, colours, border and font. */
function brandingSettings(origin, embedded) {
  const { logo, icon, ...rest } = SHOP.branding;
  const out = { ...rest };
  // Keep the embedded form on midnight too: with any light background (white, paper or cream, tested Nov 26, 2026)
  // Stripe's processing animation turns "Add code" and "View details" a fixed blue that branding can't change.
  if (embedded) return out;
  if (logo) out.logo = { type: "url", url: new URL(logo, origin).href };
  if (icon) out.icon = { type: "url", url: new URL(icon, origin).href };
  return out;
}

/* W + order date (yymmdd, Pacific time) + "-" + 4 random characters without look-alikes (no 0/O, 1/I/L). */
function makeOrderNumber() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "2-digit", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type)?.value || "00";
  const abc = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const tail = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => abc[b % abc.length]).join("");
  return `W${part("year")}${part("month")}${part("day")}-${tail}`;
}

function readOptions(raw, customFlag) {
  const given = raw && typeof raw === "object" ? raw : {};
  const parts = [];
  const addons = [];
  const values = {};
  for (const [name, def] of Object.entries(SHOP.options)) {
    let value = clean(given[name], def.maxLength || 80);
    const label = (def.label || name).toLowerCase();
    if (!value) {
      if (def.required) throw new ShopError(`Please choose a ${label} for every item.`);
      continue;
    }
    let custom = false;
    if (Array.isArray(def.values)) {
      const match = def.values.find((v) => v.toLowerCase() === value.toLowerCase());
      if (match) value = match;
      else if (def.allowCustom) custom = true;
      else throw new ShopError(`"${value}" isn't an available ${label}.`);
    } else if (customFlag) {
      custom = true;
    }
    if (def.addons && def.addons[value]) addons.push(def.addons[value]);
    parts.push(custom ? `${value} (custom)` : value);
    values[name] = custom ? `${value} (custom)` : value;
  }
  return { text: parts.join(", "), addons, values };
}

function readDetails(raw) {
  const given = raw && typeof raw === "object" ? raw : {};
  const fields = {};
  for (const f of SHOP.details) {
    const value = clean(given[f.key], Math.min(f.maxLength || 200, 500));
    if (!value && f.required) throw new ShopError(`Please fill in ${f.label}.`);
    if (value) fields[f.key.slice(0, 40)] = value;
  }
  const email = clean(given.email, 200);
  return { fields, email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "" };
}

/* Stripe metadata: at most 50 keys, 500 characters per value. The order lines go into
   order_1, order_2 … so the owner sees every option on the payment in the Dashboard. */
function buildMetadata(fields, summary) {
  const md = { source: "website", ...fields };
  const room = 50 - Object.keys(md).length;
  const chunks = [];
  for (const line of summary) {
    const piece = truncate(line, 500);
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + piece.length <= 500) chunks[chunks.length - 1] = last + "\n" + piece;
    else chunks.push(piece);
  }
  if (chunks.length > room) {
    chunks.length = room;
    chunks[room - 1] = truncate(chunks[room - 1], 480) + "\n…(more lines; see Checkout line items)";
  }
  chunks.forEach((c, i) => { md[`order_${i + 1}`] = c; });
  return md;
}

/* ---------- Order status for the thank-you page ---------- */

async function order(url, env) {
  const id = url.searchParams.get("session_id") || "";
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) throw new ShopError("Unknown order.");
  const s = await stripe(env, "GET", `checkout/sessions/${id}`);
  const complete = s.status === "complete";
  // paid: money received. free: a code (coupon or gift card) covered it. Stripe reports a 0 total promotion-code
  // order as "paid" with amount_total 0 and no PaymentIntent (seen in test, Nov 2026), and other zero-total
  // sessions as "no_payment_required", so check both.
  const free = complete && (s.payment_status === "no_payment_required" || s.amount_total === 0);
  const paid = complete && (s.payment_status === "paid" || free);
  const pending = complete && s.payment_status === "unpaid";
  return json({ paid, free, pending, status: s.status, amount_total: s.amount_total, currency: s.currency,
    order_number: s.metadata?.order_number || s.client_reference_id || null },
    200, { "Cache-Control": "no-store" });
}

/* ---------- Catalog (cached) ---------- */

let memo = null;

async function loadCatalog(env, ctx, origin) {
  const mode = isTest(env) ? "test" : "live";
  const now = Date.now();
  if (memo && memo.mode === mode && now - memo.at < SHOP.cacheSeconds * 1000) return memo.data;

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = `${origin}/__shop-cache/catalog-${mode}-v1`;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const data = await hit.json();
      memo = { at: now, mode, data };
      return data;
    }
  }
  const data = await fetchCatalog(env, mode);
  memo = { at: now, mode, data };
  if (cache) {
    const put = cache.put(cacheKey, new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${SHOP.cacheSeconds}` },
    }));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put); else await put;
  }
  return data;
}

async function fetchCatalog(env, mode) {
  const needShipping = SHOP.shippingCountries.length > 0 && SHOP.shippingRates === "auto";
  const [products, rates, taxes] = await Promise.all([
    listAll(env, "products", { active: true, expand: ["data.default_price"] }),
    needShipping ? listAll(env, "shipping_rates", { active: true }) : [],
    SHOP.tax === "rates" ? listAll(env, "tax_rates", { active: true }) : [],
  ]);

  const items = [];
  const seen = new Set();
  for (const p of products) {
    const price = p.default_price;
    const md = p.metadata || {};
    if (!price || typeof price !== "object" || !price.active || price.type !== "one_time") continue;
    if (price.currency !== SHOP.currency || price.unit_amount == null) continue;
    if (md.shop === "no" || (SHOP.catalog === "tagged" && md.shop !== "yes")) continue;
    const key = md.key || p.id;
    if (seen.has(key)) { console.warn(`shop: two products use the key "${key}"; keeping the first`); continue; }
    seen.add(key);
    items.push({
      key, priceId: price.id, productId: p.id, name: p.name, description: p.description || "", images: p.images || [],
      unit_label: p.unit_label || "", amount: price.unit_amount, tax_behavior: price.tax_behavior,
      category: md.category || "", group: md.group || "", badge: md.badge || "", sort: Number(md.sort) || 0,
    });
  }
  items.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  const shippingRates = Array.isArray(SHOP.shippingRates) ? SHOP.shippingRates : rates
    .filter((r) => r.type === "fixed_amount" && r.fixed_amount?.currency === SHOP.currency && r.metadata?.shop !== "no")
    .sort((a, b) => a.fixed_amount.amount - b.fixed_amount.amount)
    .slice(0, 5)
    .map((r) => r.id);
  const taxRates = taxes.filter((t) => t.metadata?.shop !== "no").map((t) => t.id);

  return { mode, products: items, shippingRates, taxRates };
}

function publicProduct(p) {
  return {
    key: p.key, name: p.name, description: p.description, images: p.images, unit_label: p.unit_label,
    price: { amount: p.amount, currency: SHOP.currency, tax_behavior: p.tax_behavior },
    category: p.category, group: p.group, badge: p.badge, sort: p.sort,
  };
}

/* ---------- Stripe REST helpers (no SDK: smaller and faster on the free plan) ---------- */

const STRIPE_VERSION = "2024-06-20";   // pinned so a change to the account's default API version can't break checkout

async function listAll(env, path, params) {
  const out = [];
  let startingAfter;
  for (let page = 0; page < 10; page++) {
    const res = await stripe(env, "GET", path, { ...params, limit: 100, starting_after: startingAfter });
    out.push(...res.data);
    if (!res.has_more || !res.data.length) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return out;
}

async function stripe(env, method, path, params) {
  const form = params ? encodeForm(params) : "";
  const res = await fetch(`https://api.stripe.com/v1/${path}${method === "GET" && form ? "?" + form : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body: method === "GET" ? undefined : form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.stripe = data.error || {};
    throw err;
  }
  return data;
}

/* { a: { b: [1, { c: 2 }] } } -> a[b][0]=1&a[b][1][c]=2  (Stripe's form encoding) */
export function encodeForm(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}

/* ---------- Small helpers ---------- */

const isTest = (env) => /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY || "");
const truncate = (s, max) => (s.length <= max ? s : s.slice(0, max - 1) + "…");
const clean = (v, max) => (typeof v === "string" || typeof v === "number")
  ? String(v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
  : "";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...headers },
  });
}
