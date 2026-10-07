"use strict";
/*
 * reorder.js — Wave-2A: job-scoped reorder (P2-11 BEAT) + Save-Cart-as-Quote
 * (P2-5 copy semantics).
 *
 * P2-11 (BEAT Lowe's Buy It Again): reorder keyed to the JOB that bought it.
 * History = the customer's past converted quotes (recorded by this proxy at
 * conversion time) + their Shopify order history + the Axis copies of those
 * orders, searchable by quote name / PO / job name / order #.
 *
 * Pricing rule (task-locked):
 *   - Every source line still exists in the Axis catalog => create a NEW draft
 *     quote whose lines carry the ORIGINAL unit prices (price_unit passed
 *     explicitly — that IS our price memory; normal quote lines omit
 *     price_unit so the pricelist computes, reorder lines deliberately pin).
 *   - Any item changed/missing => fall back to a current-price cart permalink
 *     with a visible "prices updated" notice. Never silently reprice.
 *
 * P2-5 (COPY, not Lowe's MOVE): Save-Cart-as-Quote copies the cart's lines
 * into a new named draft quote; the cart is NEVER emptied (the backend has no
 * cart access at all — copy semantics are structural). UI says so explicitly.
 *
 * TRUST NOTES (match the existing /proxy/quotes?email= model):
 *   - Identity is the email address. Requests arrive through the Shopify app
 *     proxy (HMAC-verified), so only Shopify-forwarded traffic reaches these
 *     endpoints, but any caller who can present an email through that path
 *     sees that identity's quote/order history — exactly the same exposure as
 *     the existing quote list. No additional secret is assumed.
 *   - Save-Cart-as-Quote: the client passes the cart's lines. ONLY sku + qty
 *     are accepted (parseStructuredLines drops every other field, including
 *     any client-supplied price). Prices are computed server-side by Axis
 *     pricelists at quote time. A forged client can therefore never set a price.
 *   - Reorder from a Shopify order: the order's own email is verified against
 *     the request identity (sameEmail) before its lines are released, so one
 *     customer cannot reorder from another customer's order id.
 *
 * Pure helpers (reorderName, sameEmail, historyMatches, planReorderLines,
 * buildCartPermalink, entriesForEmail) are Axis-free and unit-tested in
 * scripts/test-w2a-units.js. The ReorderService reuses ONLY stable
 * QuoteService methods (findQuote, getQuote, findPartnerId, resolvePartner,
 * refreshCache) so it works against both the deployed Wave-1 quotes.js and
 * later trees.
 */

const crypto = require("crypto");
const bulk = require("./bulk");
const skuMap = require("./sku-map");
const registry = require("./registry");
// HttpError MUST be the quotes.js class — server.js catches with
// `e instanceof HttpError`; a second class would turn 4xx into 502.
const { QUOTE_FOOTER, HttpError } = require("./quotes");

const REORDER_SUFFIX = " (Reorder)";
const MAX_NAME = 120;
const HISTORY_LIMIT = 25;

const PRICES_UPDATED_NOTICE =
  "Some items from this job have changed since — this cart uses current prices. Review before checkout.";
const CART_UNCHANGED_NOTICE =
  "Your cart is unchanged — its items were copied into the quote.";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ---------------- pure helpers (unit-tested) ---------------- */

/** "<job> (Reorder)", capped so client_order_ref stays sane. */
function reorderName(sourceName) {
  const base = String(sourceName || "Reorder").trim() || "Reorder";
  return (base + REORDER_SUFFIX).slice(0, MAX_NAME);
}

/** Email identity comparison — trim + case-insensitive (the alias trust path). */
function sameEmail(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_RE.test(String(email || ""));
}

/**
 * Substring filter for the reorder history: matches q (case-insensitive)
 * against any of the entry's searchable fields (quote name, quote #, order
 * name). Empty/short q matches everything (initial list load).
 */
function historyMatches(q, fields) {
  const needle = String(q || "").trim().toLowerCase();
  if (needle.length < 1) return true;
  return fields.some((f) => String(f || "").toLowerCase().includes(needle));
}

/**
 * Registry entries belonging to an email identity, newest conversion first.
 * The registry records proxy-touched quotes; converted_at is set when a quote
 * is converted to a cart (that is a "past converted quote" for reorder).
 * Pure: the registry rows are injected.
 */
function entriesForEmail(rows, email) {
  return (rows || [])
    .filter((r) => r.converted_at && sameEmail(r.email, email))
    .sort((a, b) => String(b.converted_at).localeCompare(String(a.converted_at)));
}

/**
 * Decide the reorder path from source lines.
 *   lines:   [{product_id?, sku?, qty, unit_price, title}]
 *   resolve: injected existence check -> {product_id, sku} | null
 *             (production: Axis product lookup; tests: a stub)
 * Returns { mode: "quote" | "cart", honored: [...], missing: [...] }.
 * mode "quote" ONLY when every line resolves — honored original pricing.
 * Any miss => "cart": current-price fallback with a prices-updated notice.
 */
function planReorderLines(lines, resolve) {
  const honored = [];
  const missing = [];
  for (const l of lines || []) {
    const hit = resolve(l);
    if (hit) {
      honored.push({
        product_id: hit.product_id,
        sku: hit.sku || l.sku || null,
        qty: Number(l.qty) || 1,
        unit_price: Number(l.unit_price) || 0,
        title: l.title || null,
      });
    } else {
      missing.push({
        sku: l.sku || null,
        qty: Number(l.qty) || 1,
        title: l.title || null,
        reason: "item is no longer in the catalog",
      });
    }
  }
  return { mode: missing.length === 0 && honored.length > 0 ? "quote" : "cart", honored, missing };
}

/**
 * Current-price cart permalink fallback (Shopify owns price at checkout).
 * lookup is injected (skuMap.lookup in production). Lines that cannot be
 * mapped to a variant are listed loudly, never silently dropped.
 */
function buildCartPermalink(lines, lookup) {
  const items = [];
  const unmapped = [];
  for (const l of lines || []) {
    const m = l.sku ? lookup(l.sku) : null;
    if (!m) {
      unmapped.push({
        sku: l.sku || null,
        qty: l.qty,
        title: l.title || null,
        reason: l.sku ? "SKU not mapped to a Shopify variant" : "no SKU on this line",
      });
      continue;
    }
    items.push({ variant_id: m.variant_id, qty: l.qty });
  }
  return {
    permalink: items.length ? "/cart/" + items.map((i) => `${i.variant_id}:${i.qty}`).join(",") : null,
    items,
    unmapped,
  };
}

/* ---------------- Shopify order history (client_credentials, in-memory token) ----------------
 * Same auth pattern as order-sync.js (duplicated deliberately: zero edits to
 * the order-sync module). Configured via SHOPIFY_CLIENT_ID + SHOPIFY_APP_SECRET
 * (or SHOPIFY_ADMIN_TOKEN as a dev override). When unconfigured the reorder
 * history simply serves the Axis sources only.
 */
class ShopifyHistory {
  constructor({ shopDomain, clientId, clientSecret, staticToken }) {
    this.shop = shopDomain;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = staticToken || null;
    this.tokenExp = staticToken ? Infinity : 0; // static tokens never re-mint
    this.apiVersion = process.env.SHOPIFY_API_VERSION || "2026-07";
  }

  configured() {
    return !!(this.clientId && this.clientSecret) || !!this.token;
  }

  async _mint() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(`https://${this.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`Shopify token mint failed: HTTP ${res.status}`);
    const data = await res.json();
    this.token = data.access_token; // memory only — never logged, never persisted
    this.tokenExp = Date.now() + (Number(data.expires_in) - 300) * 1000;
  }

  async get(pathWithQuery, { retried401 = false, attempts = 3 } = {}) {
    if (!this.token || Date.now() >= this.tokenExp) await this._mint();
    const res = await fetch(`https://${this.shop}/admin/api/${this.apiVersion}/${pathWithQuery}`, {
      headers: { "X-Shopify-Access-Token": this.token },
    });
    if (res.status === 401 && !retried401 && this.clientId) {
      this.token = null;
      return this.get(pathWithQuery, { retried401: true, attempts });
    }
    if (res.status === 429 && attempts > 0) {
      const wait = (parseFloat(res.headers.get("retry-after") || "2") + Math.random()) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.get(pathWithQuery, { retried401, attempts: attempts - 1 });
    }
    if (!res.ok) throw new Error(`Shopify ${pathWithQuery}: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * GraphQL call. Orders are searched with the order-search syntax
   * (`email:foo@bar.com`) — this needs ONLY read_orders, which the app has;
   * the REST customers/search path would need read_customers (not granted).
   */
  async gql(query, variables, { retried401 = false, attempts = 3 } = {}) {
    if (!this.token || Date.now() >= this.tokenExp) await this._mint();
    const res = await fetch(`https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": this.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && !retried401 && this.clientId) {
      this.token = null;
      return this.gql(query, variables, { retried401: true, attempts });
    }
    if (res.status === 429 && attempts > 0) {
      const wait = (parseFloat(res.headers.get("retry-after") || "2") + Math.random()) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.gql(query, variables, { retried401, attempts: attempts - 1 });
    }
    if (!res.ok) throw new Error(`Shopify graphql: HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors && body.errors.length) throw new Error(`Shopify graphql: ${body.errors[0].message}`);
    return body.data || {};
  }

  /** Map a GraphQL order node to the internal shape. */
  _mapOrder(n) {
    if (!n) return null;
    return {
      id: Number(String(n.id).replace(/\D+/g, "")) || n.id,
      name: n.name,
      email: n.email || null,
      created_at: n.createdAt,
      cancelled_at: n.cancelledAt || null,
      total_price: n.totalPriceSet && n.totalPriceSet.shopMoney ? Number(n.totalPriceSet.shopMoney.amount) : null,
      line_items: ((n.lineItems && n.lineItems.nodes) || []).map((li) => ({
        sku: li.sku || null,
        quantity: li.quantity,
        price: li.originalUnitPriceSet && li.originalUnitPriceSet.shopMoney
          ? Number(li.originalUnitPriceSet.shopMoney.amount)
          : null,
        title: li.title,
        variant_title: li.variantTitle || null,
      })),
    };
  }

  /** Orders for an email identity (order-search path; newest first). */
  async ordersForEmail(email) {
    const data = await this.gql(
      `query ($q: String!) {
        orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id name email createdAt cancelledAt
            totalPriceSet { shopMoney { amount } }
            lineItems(first: 100) {
              nodes { sku quantity title variantTitle originalUnitPriceSet { shopMoney { amount } } }
            }
          }
        }
      }`,
      { q: `email:${String(email).trim().toLowerCase()}` }
    );
    return ((data.orders && data.orders.nodes) || [])
      .map((n) => this._mapOrder(n))
      .filter((o) => o && !o.cancelled_at && sameEmail(o.email, email));
  }

  /** One order by numeric id. Null when unknown. */
  async orderById(id) {
    let data;
    try {
      data = await this.gql(
        `query ($id: ID!) {
          order(id: $id) {
            id name email createdAt cancelledAt
            totalPriceSet { shopMoney { amount } }
            lineItems(first: 100) {
              nodes { sku quantity title variantTitle originalUnitPriceSet { shopMoney { amount } } }
            }
          }
        }`,
        { id: `gid://shopify/Order/${id}` }
      );
    } catch {
      return null;
    }
    const o = this._mapOrder(data.order);
    return o && !o.cancelled_at ? o : null;
  }
}

/* ---------------- service ---------------- */

class ReorderService {
  /**
   * @param quoteSvc QuoteService instance (stable methods only)
   * @param cfg      proxy config
   */
  constructor(quoteSvc, cfg) {
    this.svc = quoteSvc;
    this.axis = quoteSvc.axis;
    this.cfg = cfg;
    this.shopify = new ShopifyHistory({
      shopDomain: cfg.shopify.shopDomain,
      clientId: process.env.SHOPIFY_CLIENT_ID || null,
      clientSecret: process.env.SHOPIFY_APP_SECRET || null,
      staticToken: process.env.SHOPIFY_ADMIN_TOKEN || null,
    });
  }

  lineKey(email, orderId, sku, qty) {
    // Same shape as quotes.js lineKey (day-scoped idempotency marker).
    const day = new Date().toISOString().slice(0, 10);
    return crypto
      .createHash("sha256")
      .update(`${String(email).toLowerCase()}|${orderId}|${sku}|${qty}|${day}`)
      .digest("hex")
      .slice(0, 10);
  }

  /**
   * Record a conversion (called fire-and-forget from the convert route after a
   * permalink is issued). This is what makes a quote discoverable as a "past
   * converted quote" on the reorder surface. Registry is proxy-side; loss on
   * container recreation degrades history to Axis/Shopify sources (fail-safe).
   */
  async recordConversion(email, ref, convertPayload) {
    if (!convertPayload || !convertPayload.permalink) return; // pending/blocked conversions don't count
    try {
      const order = await this.svc.findQuote(email, ref);
      registry.record({
        orderId: order.id,
        email,
        quoteNo: order.name,
        name: order.client_order_ref || order.name,
        validityDate: order.validity_date,
        convertedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("[reorder] recordConversion failed (non-fatal):", e.message);
    }
  }

  /* ---------------- reorder history (P2-11) ---------------- */

  /**
   * Unified reorder history for an email identity:
   *   1. past converted quotes (proxy registry, verified still in Axis)
   *   2. Axis copies of Shopify orders for this partner (origin marker, draft|sale)
   *   3. live Shopify order history (authoritative; dedupes source 2 by order name)
   * Searchable by quote name / quote # / PO / job name / order #.
   */
  async reorderHistory(email, q = "") {
    const partnerId = await this.svc.findPartnerId(email);
    const results = [];

    // 1) converted quotes recorded by this proxy
    if (partnerId) {
      const rows = entriesForEmail(registry.all(), email);
      for (const entry of rows.slice(0, HISTORY_LIMIT)) {
        const found = await this.axis.searchRead(
          "sale.order",
          [["id", "=", entry.order_id], ["partner_id", "=", partnerId]],
          ["id", "name", "client_order_ref", "amount_total", "order_line", "validity_date"],
          { limit: 1 }
        );
        if (!found.length) continue; // deleted since conversion
        const o = found[0];
        results.push({
          kind: "quote",
          ref: o.id,
          name: o.client_order_ref || o.name,
          sub: o.name,
          total: o.amount_total,
          line_count: o.order_line.length,
          when: entry.converted_at,
          source: "converted_quote",
        });
      }

      // 2) Axis copies of Shopify orders (order-sync writes origin = "Shopify order #…")
      const axisOrders = await this.axis.searchRead(
        "sale.order",
        [
          ["partner_id", "=", partnerId],
          ["origin", "=like", "Shopify order %"],
          ["state", "in", ["draft", "sale"]],
        ],
        ["id", "name", "client_order_ref", "origin", "date_order", "amount_total", "order_line"],
        { order: "date_order desc", limit: 50 }
      );
      for (const o of axisOrders) {
        results.push({
          kind: "order",
          ref: String(o.client_order_ref || "").trim() || o.name, // Shopify order name ("#151081")
          axis_id: o.id,
          name: o.client_order_ref || o.origin,
          sub: o.origin,
          total: o.amount_total,
          line_count: o.order_line.length,
          when: o.date_order,
          source: "axis_order",
        });
      }
    }

    // 3) live Shopify order history (dedupes source 2 by order name)
    let shopifyAvailable = this.shopify.configured();
    if (shopifyAvailable) {
      try {
        const orders = await this.shopify.ordersForEmail(email);
        const seen = new Set(results.filter((r) => r.kind === "order").map((r) => r.ref));
        for (const o of orders) {
          if (seen.has(o.name)) continue;
          results.push({
            kind: "order",
            ref: String(o.id),
            name: o.name,
            sub: `${(o.line_items || []).length} item${(o.line_items || []).length === 1 ? "" : "s"}`,
            total: Number(o.total_price) || 0,
            line_count: (o.line_items || []).length,
            when: o.created_at,
            source: "shopify",
          });
        }
      } catch (e) {
        shopifyAvailable = false;
        console.warn("[reorder] Shopify history unavailable (Axis sources still served):", e.message);
      }
    }

    const filtered = results
      .filter((r) => historyMatches(q, [r.name, r.sub, r.ref]))
      .sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")))
      .slice(0, HISTORY_LIMIT);
    return {
      results: filtered,
      sources: {
        converted_quotes: true,
        axis_orders: !!partnerId,
        shopify: shopifyAvailable,
      },
      trust_note:
        "Identity is the email address, same as the My Quotes list: requests arrive through the HMAC-verified Shopify app proxy; no additional secret is assumed.",
    };
  }

  /* ---------------- reorder execution (P2-11) ---------------- */

  /**
   * Reorder from { type: "quote"|"order", ref }.
   * All source lines still in the catalog => NEW draft quote at ORIGINAL
   * prices (price memory). Any item changed => current-price cart permalink
   * with a visible prices-updated notice. Never silently repriced.
   */
  async reorder(email, { type, ref } = {}) {
    if (!type || !ref) throw badRequest("source.type (quote|order) and source.ref are required");
    if (type === "quote") return this.reorderFromQuote(email, ref);
    if (type === "order") return this.reorderFromOrder(email, ref);
    throw badRequest("source.type must be quote | order");
  }

  async reorderFromQuote(email, ref) {
    const order = await this.svc.findQuote(email, ref); // partner-scoped, any state
    if (!order.order_line.length) throw badRequest(`quote ${order.name} has no lines to reorder`);
    const lines = await this.axis.read("sale.order.line", order.order_line, [
      "id", "product_id", "name", "product_uom_qty", "price_unit",
    ]);
    const prodIds = [...new Set(lines.map((l) => l.product_id && l.product_id[0]).filter(Boolean))];
    const prods = prodIds.length
      ? await this.axis.read("product.product", prodIds, ["id", "default_code", "name"])
      : [];
    const byId = new Map(prods.map((p) => [p.id, p]));

    const sourceLines = lines.map((l) => {
      const pid = l.product_id && l.product_id[0];
      return {
        product_id: pid,
        sku: (byId.get(pid) && byId.get(pid).default_code) || null,
        qty: l.product_uom_qty,
        unit_price: l.price_unit,
        title: cleanName(l.name),
      };
    });
    const plan = planReorderLines(sourceLines, (l) => {
      const p = l.product_id ? byId.get(l.product_id) : null;
      return p ? { product_id: p.id, sku: p.default_code || l.sku } : null;
    });
    return this.executeReorder(email, order.client_order_ref || order.name, plan, {
      from: "quote",
      from_ref: order.name,
    });
  }

  async reorderFromOrder(email, ref) {
    // Preferred path: live Shopify order, with identity verification.
    if (this.shopify.configured()) {
      let order = null;
      if (/^\d+$/.test(String(ref))) {
        order = await this.shopify.orderById(ref);
      } else {
        // by name ("#151081") — find within this identity's own history
        const mine = await this.shopify.ordersForEmail(email);
        order = mine.find((o) => String(o.name) === String(ref)) || null;
        if (order) order = await this.shopify.orderById(order.id);
      }
      if (order) {
        // Identity check: the order must belong to this email identity.
        if (!sameEmail(order.email, email)) throw notFound("order not found for this email");
        const lines = (order.line_items || []).map((li) => ({
          sku: li.sku ? String(li.sku) : null,
          qty: li.quantity,
          unit_price: Number(li.price),
          title: li.variant_title && li.variantTitle !== "Default Title"
            ? `${li.title} — ${li.variantTitle}`
            : li.title,
        }));
        if (!lines.length) throw badRequest(`order ${order.name} has no lines to reorder`);
        const plan = await this.planAgainstAxisBySku(lines);
        return this.executeReorder(email, order.name, plan, { from: "order", from_ref: order.name });
      }
      // fall through to the Axis copy when Shopify has no such order
    }

    // Axis fallback: the order-sync copy (origin = "Shopify order <name>").
    const partnerId = await this.svc.findPartnerId(email);
    if (!partnerId) throw notFound("order not found for this email");
    const origin = /^#\d+$/.test(String(ref)) || /^\d+$/.test(String(ref))
      ? null // numeric ref is a Shopify id — no Axis origin form
      : `Shopify order ${ref}`;
    const domain = origin
      ? [["partner_id", "=", partnerId], ["origin", "=", origin], ["state", "in", ["draft", "sale"]]]
      : [["partner_id", "=", partnerId], ["client_order_ref", "=", String(ref)], ["state", "in", ["draft", "sale"]]];
    const found = await this.axis.searchRead(
      "sale.order",
      domain,
      ["id", "name", "client_order_ref", "origin", "order_line"],
      { limit: 1 }
    );
    if (!found.length) throw notFound("order not found for this email");
    const o = found[0];
    if (!o.order_line.length) throw badRequest(`order ${ref} has no lines to reorder`);
    const lines = await this.axis.read("sale.order.line", o.order_line, [
      "id", "product_id", "name", "product_uom_qty", "price_unit",
    ]);
    const prodIds = [...new Set(lines.map((l) => l.product_id && l.product_id[0]).filter(Boolean))];
    const prods = prodIds.length
      ? await this.axis.read("product.product", prodIds, ["id", "default_code", "name"])
      : [];
    const byId = new Map(prods.map((p) => [p.id, p]));
    const sourceLines = lines.map((l) => {
      const pid = l.product_id && l.product_id[0];
      return {
        product_id: pid,
        sku: (byId.get(pid) && byId.get(pid).default_code) || null,
        qty: l.product_uom_qty,
        unit_price: l.price_unit,
        title: cleanName(l.name),
      };
    });
    const plan = planReorderLines(sourceLines, (l) => {
      const p = l.product_id ? byId.get(l.product_id) : null;
      return p ? { product_id: p.id, sku: p.default_code || l.sku } : null;
    });
    return this.executeReorder(email, o.client_order_ref || o.origin, plan, {
      from: "order",
      from_ref: o.client_order_ref || o.origin,
    });
  }

  /** Resolve Shopify-sourced lines (sku-based) against the Axis catalog. */
  async planAgainstAxisBySku(lines) {
    const skus = [...new Set(lines.map((l) => l.sku).filter(Boolean))];
    const prods = skus.length
      ? await this.axis.searchRead(
          "product.product",
          [["default_code", "in", skus]],
          ["id", "default_code", "name"],
          { limit: 10000, order: "id asc" }
        )
      : [];
    const bySku = new Map();
    for (const p of prods) {
      const key = String(p.default_code).toUpperCase();
      if (!bySku.has(key)) bySku.set(key, p);
    }
    return planReorderLines(lines, (l) => {
      if (!l.sku) return null;
      const p = bySku.get(String(l.sku).toUpperCase());
      return p ? { product_id: p.id, sku: p.default_code } : null;
    });
  }

  /** Shared tail of both reorder paths. */
  async executeReorder(email, sourceName, plan, meta) {
    if (plan.mode === "quote") {
      const quote = await this.buildReorderQuote(email, sourceName, plan.honored);
      return {
        mode: "quote",
        honored_pricing: true,
        prices_updated: false,
        quote,
        missing: [],
        ...meta,
        footer: QUOTE_FOOTER.replace("{expiry}", quote.expiry || ""),
      };
    }
    // Current-price cart fallback. Every source line with a SKU is attempted;
    // anything unmappable is listed loudly. Prices are CURRENT (Shopify owns
    // price at checkout) — the notice says so.
    const all = plan.honored.concat(plan.missing);
    const fb = buildCartPermalink(all, (sku) => skuMap.lookup(sku));
    if (!fb.items.length) {
      throw badRequest(
        "none of this job's items could be mapped to current products — nothing to reorder"
      );
    }
    return {
      mode: "cart",
      honored_pricing: false,
      prices_updated: true,
      notice: PRICES_UPDATED_NOTICE,
      permalink: fb.permalink,
      items: fb.items,
      missing: plan.missing.concat(fb.unmapped),
      ...meta,
      footer: QUOTE_FOOTER.replace("{expiry}", ""),
    };
  }

  /**
   * Create (or reuse) the "<job> (Reorder)" draft quote with lines at the
   * ORIGINAL unit prices. Idempotent (double-click safe): a still-draft quote
   * with the same reorder name is reused and its lines updated in place per
   * product (qty + price pinned again) — never duplicated. Extra lines the
   * customer added since are left untouched.
   */
  async buildReorderQuote(email, sourceName, honored) {
    const partnerId = await this.svc.resolvePartner(email);
    const name = reorderName(sourceName);
    const validity = todayPlus(this.cfg.quoteValidityDays);

    const existing = await this.axis.search(
      "sale.order",
      [
        ["partner_id", "=", partnerId],
        ["client_order_ref", "=", name],
        ["state", "=", "draft"],
      ],
      { limit: 1 }
    );
    let orderId;
    let reused = false;
    if (existing.length) {
      orderId = existing[0];
      reused = true;
    } else {
      orderId = await this.axis.create("sale.order", {
        partner_id: partnerId,
        client_order_ref: name,
        validity_date: validity,
      });
    }

    const current = await this.axis.read("sale.order", [orderId], ["order_line"]);
    const existingByProd = new Map();
    if (current[0].order_line.length) {
      const cur = await this.axis.read("sale.order.line", current[0].order_line, ["id", "product_id"]);
      for (const l of cur) {
        const pid = l.product_id && l.product_id[0];
        if (pid) existingByProd.set(pid, l.id);
      }
    }

    for (const l of honored) {
      const existingId = existingByProd.get(l.product_id);
      if (existingId) {
        await this.axis.write("sale.order.line", [existingId], {
          product_uom_qty: l.qty,
          price_unit: l.unit_price, // re-pin honored original pricing
        });
      } else {
        const key = this.lineKey(email, orderId, l.sku || `p${l.product_id}`, l.qty);
        await this.axis.create("sale.order.line", {
          order_id: orderId,
          product_id: l.product_id,
          product_uom_qty: l.qty,
          price_unit: l.unit_price, // HONORED original pricing (price memory)
          name: `${l.title || "Item"} [pesq:${key}]`,
        });
      }
    }
    // Edit semantics (D1): restate validity to today+7 on every reorder.
    await this.axis.write("sale.order", [orderId], { validity_date: validity });

    const detail = await this.svc.getQuote(email, orderId, { skipPartnerCheck: true });
    detail.reused = reused;
    await this.svc.refreshCache(email);
    registry.record({
      orderId,
      email,
      quoteNo: detail.quote_no,
      name: detail.name,
      validityDate: detail.expiry,
    });
    return detail;
  }

  /* ---------------- Save Cart as Quote (P2-5, copy semantics) ---------------- */

  /**
   * Copy the cart's lines into a new named draft quote. The cart itself is
   * NEVER touched (this backend has no cart access — copy is structural).
   * TRUST: only sku + qty are read from the client payload (parseStructuredLines
   * drops every other field, including any client-supplied price); prices are
   * computed by Axis pricelists at quote time (price_unit intentionally omitted
   * on line create — the standard quote-pricing rule, NOT the reorder pin).
   * Unresolvable SKUs fail LOUD and are listed with reasons, never dropped.
   * Idempotent: same partner + same name + still draft => reuse, lines
   * update-in-place (re-saving the same cart never duplicates).
   */
  async saveCartAsQuote(email, { name, lines } = {}) {
    if (!name || !String(name).trim()) throw badRequest("quote name is required");
    const parsed = bulk.parseStructuredLines(lines);
    if (!parsed.ok.length && !parsed.failed.length) {
      throw badRequest("the cart has no lines to save");
    }
    const partnerId = await this.svc.resolvePartner(email);

    // Axis is authoritative for SKU resolution (client resolution never trusted).
    const skus = parsed.ok.map((l) => l.sku);
    const prods = skus.length
      ? await this.axis.searchRead(
          "product.product",
          [["default_code", "in", skus]],
          ["id", "default_code", "name"],
          { limit: 10000, order: "id asc" }
        )
      : [];
    const bySku = new Map();
    for (const p of prods) {
      const key = String(p.default_code).toUpperCase();
      if (!bySku.has(key)) bySku.set(key, p);
    }

    const quoteName = String(name).trim().slice(0, MAX_NAME);
    const validity = todayPlus(this.cfg.quoteValidityDays);
    const existing = await this.axis.search(
      "sale.order",
      [
        ["partner_id", "=", partnerId],
        ["client_order_ref", "=", quoteName],
        ["state", "=", "draft"],
      ],
      { limit: 1 }
    );
    let orderId;
    let reused = false;
    if (existing.length) {
      orderId = existing[0];
      reused = true;
    } else {
      orderId = await this.axis.create("sale.order", {
        partner_id: partnerId,
        client_order_ref: quoteName,
        validity_date: validity,
      });
    }

    const current = await this.axis.read("sale.order", [orderId], ["order_line"]);
    const existingByProd = new Map();
    if (current[0].order_line.length) {
      const cur = await this.axis.read("sale.order.line", current[0].order_line, ["id", "product_id"]);
      for (const l of cur) {
        const pid = l.product_id && l.product_id[0];
        if (pid) existingByProd.set(pid, l.id);
      }
    }

    const added = [];
    const updated = [];
    const failed = parsed.failed.slice();
    for (const l of parsed.ok) {
      const prod = bySku.get(l.sku.toUpperCase());
      if (!prod) {
        failed.push({ line: l.line, raw: `${l.sku}, ${l.qty}`, sku: l.sku, reason: "SKU not found in the catalog" });
        continue;
      }
      try {
        const existingId = existingByProd.get(prod.id);
        if (existingId) {
          await this.axis.write("sale.order.line", [existingId], { product_uom_qty: l.qty });
          updated.push({ sku: l.sku, qty: l.qty, line_id: existingId });
        } else {
          const key = this.lineKey(email, orderId, l.sku, l.qty);
          const lineId = await this.axis.create("sale.order.line", {
            order_id: orderId,
            product_id: prod.id,
            product_uom_qty: l.qty,
            // price_unit intentionally omitted: Axis pricelist owns price at quote time.
            name: `${cleanName(prod.name)} [pesq:${key}]`,
          });
          existingByProd.set(prod.id, lineId);
          added.push({ sku: l.sku, qty: l.qty, line_id: lineId });
        }
      } catch (e) {
        failed.push({ line: l.line, raw: `${l.sku}, ${l.qty}`, sku: l.sku, reason: `Axis write failed: ${String(e.message).slice(0, 120)}` });
      }
    }

    if (added.length || updated.length) {
      await this.axis.write("sale.order", [orderId], { validity_date: validity });
    }
    const detail = await this.svc.getQuote(email, orderId, { skipPartnerCheck: true });
    await this.svc.refreshCache(email);
    registry.record({
      orderId,
      email,
      quoteNo: detail.quote_no,
      name: detail.name,
      validityDate: detail.expiry,
    });
    return {
      reused,
      quote: detail,
      added_count: added.length,
      updated_count: updated.length,
      failed_count: failed.length,
      added,
      updated,
      failed,
      // Copy semantics (D3) — stated explicitly for the UI:
      cart_unchanged: true,
      notice: CART_UNCHANGED_NOTICE,
      trust_note:
        "The client passes the cart's lines; only sku + qty are accepted. Prices are computed server-side at quote time — client-supplied prices are ignored.",
      footer: QUOTE_FOOTER.replace("{expiry}", detail.expiry || ""),
    };
  }
}

function cleanName(name) {
  return String(name || "").replace(/^\[[^\]]*\]\s*/, "").replace(/\s*\[pesq:[^\]]*\]\s*$/, "");
}

function todayPlus(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function badRequest(msg) { return new HttpError(400, msg); }
function notFound(msg) { return new HttpError(404, msg); }

module.exports = {
  ReorderService,
  ShopifyHistory,
  reorderName,
  sameEmail,
  isValidEmail,
  historyMatches,
  entriesForEmail,
  planReorderLines,
  buildCartPermalink,
  PRICES_UPDATED_NOTICE,
  CART_UNCHANGED_NOTICE,
  HttpError,
};
