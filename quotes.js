"use strict";
/*
 * quotes.js — quote service: Axis sale.order (draft) is the system of record.
 *
 * Field contract (spec §2):
 *   sale.order.state          draft / sent  = quote
 *   sale.order.name           quote # (SQ…, Axis sequence)
 *   sale.order.client_order_ref  job / quote name ("Fence Job")
 *   sale.order.validity_date  created + 7 days (owner default, Lowe's parity)
 *   res.partner               mapped by customer email; Shopify customer id in `ref`
 *
 * Owner-documented defaults implemented here:
 *   - 7-day validity; any line edit re-states validity to today+7 (Lowe's behavior)
 *   - quotes NEVER promise stock: nothing reserved, nothing promised
 *   - freight items excluded from price-lock language (flagged in convert payload)
 *   - guest quotes allowed with email capture (partner created from email alone)
 *   - Axis owns price at quote time (pricelist computes price_unit; we do not pass it)
 *   - Shopify owns price at checkout; >3% drift => interstitial payload, never silent
 *
 * Idempotency:
 *   - quote create: search (partner_id, client_order_ref, state=draft) first; reuse.
 *   - line write: key = sha256(email|order|sku|qty|day) stored as a `pesq:` marker
 *     in the sale.order.line `name`; same product on the same order is updated
 *     in place, never duplicated.
 */

const crypto = require("crypto");
const cache = require("./cache");
const skuMap = require("./sku-map");
const share = require("./share");
const preview = require("./preview");
const bulk = require("./bulk");
const progress = require("./progress");
const pdf = require("./pdf");
const registry = require("./registry");
const { Mailer } = require("./mailer");

const QUOTE_FOOTER =
  "Prices held until {expiry} on eligible items. Availability confirmed at order time.";

function todayPlus(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function lineKey(email, orderId, sku, qty) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash("sha256")
    .update(`${String(email).toLowerCase()}|${orderId}|${sku}|${qty}|${day}`)
    .digest("hex")
    .slice(0, 10);
}

class QuoteService {
  constructor(axis, config) {
    this.axis = axis;
    this.cfg = config;
    // Quote lifecycle emails (Wave-1). Composes + queues always; SENDS only
    // when RESEND_API_KEY is set — otherwise the rail is stubbed (outbox only).
    this.mailer = new Mailer({
      resendApiKey: config.resendApiKey,
      mailFrom: config.mailFrom,
      storefrontUrl: config.storefrontUrl,
    });
  }

  /* ---------- partner ---------- */

  async resolvePartner(email, { displayName, customerId } = {}) {
    const emailNorm = String(email).trim().toLowerCase();
    const found = await this.axis.searchRead(
      "res.partner",
      [["email", "=ilike", emailNorm]],
      ["id", "name", "email", "ref"],
      { limit: 1 }
    );
    if (found.length) {
      const p = found[0];
      // Backfill Shopify customer id onto partner.ref when we learn it.
      if (customerId && !p.ref) {
        await this.axis.write("res.partner", [p.id], { ref: `shopify_customer_${customerId}` });
      }
      return p.id;
    }
    const vals = {
      name: (displayName && displayName.trim()) || emailNorm,
      email: emailNorm,
      customer_rank: 1,
    };
    if (customerId) vals.ref = `shopify_customer_${customerId}`;
    return this.axis.create("res.partner", vals);
  }

  /* ---------- quotes ---------- */

  async createQuote({ email, name, displayName, customerId, line }) {
    if (!name || !String(name).trim()) throw badRequest("quote name is required");
    const partnerId = await this.resolvePartner(email, { displayName, customerId });

    // Idempotent create: same partner + same job name + still draft => reuse.
    const existing = await this.axis.search(
      "sale.order",
      [
        ["partner_id", "=", partnerId],
        ["client_order_ref", "=", String(name).trim()],
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
        client_order_ref: String(name).trim(),
        validity_date: todayPlus(this.cfg.quoteValidityDays),
        // state defaults to draft = quotation. No stock reservation, no invoice.
      });
    }

    let lineResult = null;
    if (line && line.sku) {
      lineResult = await this.mutateLine(email, orderId, { action: "add", ...line }, { skipCache: true });
    }

    const detail = await this.getQuote(email, orderId, { skipPartnerCheck: true });
    await this.refreshCache(email);
    registry.record({ orderId, email, quoteNo: detail.quote_no, name: detail.name, validityDate: detail.expiry });
    if (!reused) {
      // Wave-1 lifecycle email: created (to quote owner). Fire-and-forget —
      // mail failures never break quote creation.
      this.mailer.queue("created", { email, quote: detail }).catch((e) => console.warn("[mailer] created:", e.message));
    }
    return { reused, quote: detail, first_line: lineResult };
  }

  async listQuotes(email) {
    const partnerId = await this.findPartnerId(email);
    if (!partnerId) return { quotes: [] };
    const orders = await this.axis.searchRead(
      "sale.order",
      [
        ["partner_id", "=", partnerId],
        ["state", "in", ["draft", "sent"]],
      ],
      ["id", "name", "client_order_ref", "validity_date", "amount_total", "write_date", "order_line"],
      { order: "write_date desc", limit: 50 }
    );
    const today = new Date().toISOString().slice(0, 10);
    return {
      quotes: orders.map((o) => ({
        id: o.id,
        name: o.client_order_ref || o.name,
        quote_no: o.name,
        total: o.amount_total,
        expiry: o.validity_date || null,
        expires_in_days: o.validity_date ? daysBetween(today, o.validity_date) : null,
        expired: o.validity_date ? o.validity_date < today : false,
        updated_at: o.write_date,
        line_count: o.order_line.length,
        footer: QUOTE_FOOTER.replace("{expiry}", o.validity_date || ""),
      })),
    };
  }

  async getQuote(email, ref, { skipPartnerCheck = false } = {}) {
    const order = await this.findQuote(email, ref, { skipPartnerCheck });
    const lines = order.order_line.length
      ? await this.axis.read("sale.order.line", order.order_line, [
          "id", "product_id", "name", "product_uom_qty", "price_unit", "price_subtotal",
        ])
      : [];
    // Resolve SKUs + list prices for the client (theme keys on SKU; list_price
    // feeds per-line savings % and the share-view price_only masking mode).
    const prodIds = [...new Set(lines.map((l) => l.product_id && l.product_id[0]).filter(Boolean))];
    const prods = prodIds.length
      ? await this.axis.read("product.product", prodIds, ["id", "default_code", "name", "list_price"])
      : [];
    const skuByProd = Object.fromEntries(prods.map((p) => [p.id, p.default_code || null]));
    const titleByProd = Object.fromEntries(prods.map((p) => [p.id, cleanName(p.name)]));
    const listByProd = Object.fromEntries(prods.map((p) => [p.id, p.list_price]));

    const today = new Date().toISOString().slice(0, 10);

    // Non-stacking rule (deep-pass #3): contract/pricelist pricing and volume
    // discounts never stack — the progress bar is suppressed on quotes whose
    // pricelist is not the public pricelist. Unknown => fail-safe hide.
    const quotePricelistId = Array.isArray(order.pricelist_id) ? order.pricelist_id[0] : null;
    const contractPriced = await progress.isContractPriced(this.axis, quotePricelistId);
    const volumeProgress = progress.computeProgress(order.amount_total, this.cfg.volumeThreshold, {
      contractPriced,
    });

    return {
      id: order.id,
      name: order.client_order_ref || order.name,
      quote_no: order.name,
      state: order.state,
      total: order.amount_total,
      untaxed: order.amount_untaxed,
      pricelist_id: quotePricelistId,
      contract_priced: contractPriced, // true/false, null = could not determine
      volume_progress: volumeProgress,
      expiry: order.validity_date || null,
      expires_in_days: order.validity_date ? daysBetween(today, order.validity_date) : null,
      expired: order.validity_date ? order.validity_date < today : false,
      updated_at: order.write_date,
      lines: lines.map((l) => {
        const pid = l.product_id && l.product_id[0];
        const list = listByProd[pid];
        const savings =
          Number.isFinite(list) && list > 0 && l.price_unit < list
            ? Math.round(((list - l.price_unit) / list) * 1000) / 10
            : null;
        return {
          line_id: l.id,
          sku: skuByProd[pid] || null,
          title: titleByProd[pid] || cleanName(l.name),
          qty: l.product_uom_qty,
          unit_price: l.price_unit,
          line_total: l.price_subtotal,
          list_price: Number.isFinite(list) ? list : null,
          savings_pct: savings,
        };
      }),
      footer: QUOTE_FOOTER.replace("{expiry}", order.validity_date || ""),
    };
  }

  async renameQuote(email, ref, newName) {
    if (!newName || !String(newName).trim()) throw badRequest("new name is required");
    const order = await this.findQuote(email, ref);
    await this.axis.write("sale.order", [order.id], { client_order_ref: String(newName).trim() });
    await this.refreshCache(email);
    return this.getQuote(email, order.id, { skipPartnerCheck: true });
  }

  async mutateLine(email, ref, { action, sku, qty, line_id }, { skipCache = false } = {}) {
    const order = await this.findQuote(email, ref);
    if (order.state !== "draft") throw badRequest(`quote ${order.name} is ${order.state}; only draft quotes are editable`);

    if (action === "remove") {
      const lineId = line_id || (await this.findLineIdBySku(order, sku));
      if (!lineId) throw notFound("line not found on quote");
      await this.axis.unlink("sale.order.line", [lineId]);
    } else if (action === "add" || action === "update") {
      const q = Number(qty);
      if (!Number.isFinite(q) || q <= 0) throw badRequest("qty must be a positive number");
      const prod = await this.findProductBySku(sku);
      const existingId = await this.findLineIdBySku(order, sku);
      if (existingId) {
        // Idempotent update-in-place: same product on the same quote is never duplicated.
        await this.axis.write("sale.order.line", [existingId], { product_uom_qty: q });
      } else {
        const key = lineKey(email, order.id, sku, q);
        await this.axis.create("sale.order.line", {
          order_id: order.id,
          product_id: prod.id,
          product_uom_qty: q,
          // price_unit intentionally omitted: Axis pricelist owns price at quote time.
          name: `${cleanName(prod.name)} [pesq:${key}]`,
        });
      }
      // Lowe's behavior: any line edit re-states validity to today + 7 days.
      await this.axis.write("sale.order", [order.id], {
        validity_date: todayPlus(this.cfg.quoteValidityDays),
      });
    } else {
      throw badRequest("action must be add | update | remove");
    }

    const detail = await this.getQuote(email, order.id, { skipPartnerCheck: true });
    if (!skipCache) await this.refreshCache(email);
    return detail;
  }

  async refreshExpiry(email, ref) {
    const order = await this.findQuote(email, ref);
    await this.axis.write("sale.order", [order.id], {
      validity_date: todayPlus(this.cfg.quoteValidityDays),
    });
    await this.refreshCache(email);
    return this.getQuote(email, order.id, { skipPartnerCheck: true });
  }

  /**
   * Delete a quote (Lowe's parity: "You cannot undo this action").
   * Primary path: unlink the draft/sent sale.order. If Axis refuses the
   * unlink (downstream constraints), fall back to state=cancel so the quote
   * still disappears from every customer-facing list. Any share tokens
   * pointing at the order are purged either way.
   */
  async deleteQuote(email, ref) {
    const order = await this.findQuote(email, ref);
    if (!["draft", "sent"].includes(order.state)) {
      throw badRequest(`quote ${order.name} is ${order.state}; only draft/sent quotes can be deleted`);
    }
    let mode = "unlinked";
    try {
      await this.axis.unlink("sale.order", [order.id]);
    } catch (e) {
      console.warn("[quotes] unlink failed for sale.order", order.id, "— falling back to cancel:", e.message);
      await this.axis.write("sale.order", [order.id], { state: "cancel" });
      mode = "cancelled";
    }
    share.purgeOrder(order.id);
    preview.purgeOrder(order.id);
    registry.remove(order.id);
    await this.refreshCache(email);
    return { deleted: true, mode, quote_no: order.name, id: order.id };
  }

  /* ---------- Wave-1: bulk paste/CSV quick-add (P2-10 BEAT) ---------- */

  /**
   * Bulk line add. Two phases behind ONE endpoint:
   *   confirm falsy  => PREVIEW: parse + resolve against the SKU map, zero
   *                     writes; every failed line listed with a reason.
   *   confirm true   => COMMIT: re-parse server-side (client resolution is
   *                     never trusted), batch-resolve against Axis (authoritative),
   *                     add/update all resolvable lines, restate validity +7d.
   *
   * Idempotent (spec §3.2 discipline): a line whose product is already on the
   * quote is updated in place to the pasted qty, never duplicated — retrying
   * the same paste is safe.
   */
  async bulkAddLines(email, ref, { text, lines, confirm = false } = {}) {
    const order = await this.findQuote(email, ref);
    if (order.state !== "draft") throw badRequest(`quote ${order.name} is ${order.state}; only draft quotes are editable`);

    let parsed;
    if (typeof text === "string") {
      parsed = bulk.parseBulkLines(text);
    } else if (Array.isArray(lines)) {
      parsed = bulk.parseStructuredLines(lines);
    } else {
      throw badRequest("provide text (pasted lines) or lines[] (structured)");
    }
    if (!parsed.ok.length && !parsed.failed.length) {
      throw badRequest("nothing to add — paste lines as: SKU, qty");
    }

    if (!confirm) {
      // Preview only: resolve against the 24k-entry SKU map (fast, local).
      const { resolved, failed } = bulk.resolveBulk(parsed, (sku) => skuMap.lookup(sku));
      return {
        confirm: false,
        resolved,
        failed,
        resolved_count: resolved.length,
        failed_count: failed.length,
        truncated: parsed.truncated,
      };
    }

    // Commit: Axis is authoritative. Batch-resolve SKUs -> product ids.
    const skus = parsed.ok.map((l) => l.sku);
    const prods = skus.length
      ? await this.axis.searchRead(
          "product.product",
          [["default_code", "in", skus]],
          ["id", "default_code", "name"],
          { limit: skus.length + 10 }
        )
      : [];
    const prodBySku = new Map(prods.map((p) => [String(p.default_code).toUpperCase(), p]));

    // Existing lines, resolved once (update-in-place instead of duplicates).
    const existingLineIdByProd = new Map();
    if (order.order_line.length) {
      const cur = await this.axis.read("sale.order.line", order.order_line, ["id", "product_id"]);
      for (const l of cur) {
        const pid = l.product_id && l.product_id[0];
        if (pid) existingLineIdByProd.set(pid, l.id);
      }
    }

    const added = [];
    const updated = [];
    const failed = parsed.failed.slice();
    for (const l of parsed.ok) {
      const prod = prodBySku.get(l.sku.toUpperCase());
      if (!prod) {
        failed.push({ line: l.line, raw: `${l.sku}, ${l.qty}`, sku: l.sku, reason: "SKU not found in the catalog" });
        continue;
      }
      try {
        const existingId = existingLineIdByProd.get(prod.id);
        if (existingId) {
          await this.axis.write("sale.order.line", [existingId], { product_uom_qty: l.qty });
          updated.push({ line: l.line, sku: l.sku, qty: l.qty, line_id: existingId });
        } else {
          const key = lineKey(email, order.id, l.sku, l.qty);
          const lineId = await this.axis.create("sale.order.line", {
            order_id: order.id,
            product_id: prod.id,
            product_uom_qty: l.qty,
            // price_unit intentionally omitted: Axis pricelist owns price at quote time.
            name: `${cleanName(prod.name)} [pesq:${key}]`,
          });
          existingLineIdByProd.set(prod.id, lineId);
          added.push({ line: l.line, sku: l.sku, qty: l.qty, line_id: lineId });
        }
      } catch (e) {
        // Fail loud per line; one bad line never sinks the batch.
        failed.push({ line: l.line, raw: `${l.sku}, ${l.qty}`, sku: l.sku, reason: `Axis write failed: ${String(e.message).slice(0, 120)}` });
      }
    }

    if (added.length || updated.length) {
      // Lowe's behavior: any line edit re-states validity to today + 7 days.
      await this.axis.write("sale.order", [order.id], { validity_date: todayPlus(this.cfg.quoteValidityDays) });
    }
    const detail = await this.getQuote(email, order.id, { skipPartnerCheck: true });
    await this.refreshCache(email);
    return {
      confirm: true,
      added_count: added.length,
      updated_count: updated.length,
      failed_count: failed.length,
      added,
      updated,
      failed,
      quote: detail,
    };
  }

  /* ---------- Wave-1: Make a Copy (D3 family / Lowe's pass-2) ---------- */

  /**
   * Copy a quote: new quote #, fresh 7-day validity, carries ALL lines, the
   * PO/Job name (client_order_ref, as "<name> (Copy)") AND the notes —
   * Lowe's silently drops Notes on Make a Copy; we don't.
   * Pricelist carries too, so contract pricing on the source quote carries.
   * Idempotent: a copy with the same "(Copy)" name still in draft is reused
   * (double-click safe), same pattern as createQuote.
   */
  async copyQuote(email, ref) {
    const order = await this.findQuote(email, ref);
    const srcName = order.client_order_ref || order.name;
    const copyName = `${srcName} (Copy)`.slice(0, 120);
    const partnerId = await this.findPartnerId(email);
    if (!partnerId) throw notFound("no Axis partner for this email");

    const existing = await this.axis.search(
      "sale.order",
      [
        ["partner_id", "=", partnerId],
        ["client_order_ref", "=", copyName],
        ["state", "=", "draft"],
      ],
      { limit: 1 }
    );
    if (existing.length) {
      const detail = await this.getQuote(email, existing[0], { skipPartnerCheck: true });
      return { reused: true, copied_from: order.name, quote: detail };
    }

    const vals = {
      partner_id: partnerId,
      client_order_ref: copyName,
      validity_date: todayPlus(this.cfg.quoteValidityDays), // fresh 7-day hold
    };
    const pricelistId = Array.isArray(order.pricelist_id) ? order.pricelist_id[0] : null;
    if (pricelistId) vals.pricelist_id = pricelistId; // contract pricing carries
    if (order.note) vals.note = order.note; // notes carry (Lowe's drops these)
    const newId = await this.axis.create("sale.order", vals);

    if (order.order_line.length) {
      const srcLines = await this.axis.read("sale.order.line", order.order_line, ["product_id", "product_uom_qty", "name"]);
      for (const l of srcLines) {
        const pid = l.product_id && l.product_id[0];
        if (!pid) continue;
        const key = lineKey(email, newId, `copy-${pid}`, l.product_uom_qty);
        const baseName = String(l.name || "").replace(/\s*\[pesq:[^\]]*\]\s*$/, "");
        await this.axis.create("sale.order.line", {
          order_id: newId,
          product_id: pid,
          product_uom_qty: l.product_uom_qty,
          // price_unit intentionally omitted: the carried pricelist reprices.
          name: `${baseName} [pesq:${key}]`,
        });
      }
    }

    await this.refreshCache(email);
    const detail = await this.getQuote(email, newId, { skipPartnerCheck: true });
    return { reused: false, copied_from: order.name, quote: detail };
  }

  /* ---------- Wave-1: Preview as client (P2-9 BEAT) ---------- */

  /**
   * Create an ephemeral (15-min) preview token for the recipient view.
   * Never touches the real share-token store: creating a preview cannot
   * revoke or pollute live share links.
   */
  async previewQuote(email, ref, { mode, note } = {}) {
    const order = await this.findQuote(email, ref);
    if (!["draft", "sent"].includes(order.state)) {
      throw badRequest(`quote ${order.name} is ${order.state}; only active quotes can be previewed`);
    }
    return preview.createPreview({ orderId: order.id, quoteNo: order.name, mode, note });
  }

  /* ---------- share with price masking (P1) ---------- */

  /**
   * Create (or regenerate) a share link for a quote. Regenerating revokes
   * prior live tokens for the order — that is the revocation path, plus
   * explicit revokeShare below. Token store is proxy-side (see share.js).
   */
  async shareQuote(email, ref, { mode, note } = {}) {
    const order = await this.findQuote(email, ref);
    if (!["draft", "sent"].includes(order.state)) {
      throw badRequest(`quote ${order.name} is ${order.state}; only active quotes can be shared`);
    }
    const out = share.createShare({ orderId: order.id, quoteNo: order.name, mode, note });
    // Wave-1 lifecycle email: shared (to owner, incl. masking mode + link).
    this.getQuote(email, order.id, { skipPartnerCheck: true })
      .then((detail) => this.mailer.queue("shared", { email, quote: detail, share: { mode, share_path: out.share_path } }))
      .catch((e) => console.warn("[mailer] shared:", e.message));
    return out;
  }

  async revokeShare(email, ref, { token } = {}) {
    const order = await this.findQuote(email, ref);
    return { revoked: share.revokeShare({ orderId: order.id, token }) };
  }

  /**
   * Token-gated shared view. NO email/partner check — the unguessable token
   * is the capability (contractor forwards the link to their client).
   * The payload is masked per the stored mode; in mode "none" no price field
   * exists anywhere in the response.
   *
   * Wave-1: real share tokens are checked FIRST; on a miss, ephemeral
   * 15-minute preview tokens (P2-9 "Preview as client") resolve through the
   * exact same masked recipient view, flagged with preview:true so the theme
   * shows a preview banner. Preview tokens never appear in the share store.
   */
  async getSharedQuote(token) {
    const rec = share.lookupToken(token);
    if (rec) {
      const detail = await this.getQuote(null, rec.order_id, { skipPartnerCheck: true });
      const masked = share.maskQuote(detail, rec.mode);
      masked.note = rec.note || null;
      masked.shared_at = rec.created_at;
      masked.preview = false;
      return masked;
    }
    const pv = preview.lookupPreview(token);
    if (pv === "expired") throw notFound("preview link expired (previews last 15 minutes) — open a fresh preview from the quote");
    if (!pv) throw notFound("shared quote not found or link revoked");
    const detail = await this.getQuote(null, pv.order_id, { skipPartnerCheck: true });
    const masked = share.maskQuote(detail, pv.mode);
    masked.note = pv.note || null;
    masked.shared_at = pv.created_at;
    masked.preview = true;
    masked.preview_expires_at = pv.expires_at;
    return masked;
  }

  /**
   * Convert quote -> Shopify cart permalink.
   * Shopify owns price at checkout; we compare quoted vs current price and
   * flag >3% drift for the interstitial. Price DROPS never block. Freight
   * lines are flagged and excluded from price-lock language.
   */
  async convertQuote(email, ref) {
    const quote = await this.getQuote(email, ref);
    const items = [];
    const drift = [];
    const skipped = [];
    for (const l of quote.lines) {
      const m = l.sku ? skuMap.lookup(l.sku) : null;
      if (!m) {
        skipped.push({ sku: l.sku, title: l.title, reason: "SKU not mapped to a Shopify variant" });
        continue;
      }
      items.push({ variant_id: m.variant_id, qty: l.qty });
      const current = Number(m.shopify_price);
      const quoted = Number(l.unit_price);
      if (quoted > 0 && Number.isFinite(current)) {
        const pct = (current - quoted) / quoted;
        if (pct > this.cfg.driftReviewPct) {
          drift.push({
            sku: l.sku, title: l.title, quoted, current,
            pct: Math.round(pct * 1000) / 10,
            freight_excluded: !!m.freight,
          });
        }
      }
    }
    if (!items.length) throw badRequest("no quotable lines could be mapped to Shopify variants");
    const permalink = "/cart/" + items.map((i) => `${i.variant_id}:${i.qty}`).join(",");
    // Wave-1 lifecycle email: converted (to owner). The cart URL is relative
    // to the storefront; the mailer prefixes it.
    this.mailer.queue("converted", {
      email,
      quote,
      cartUrl: (this.cfg.storefrontUrl || "https://www.portlandiaelectric.supply") + permalink,
    }).catch((e) => console.warn("[mailer] converted:", e.message));
    return {
      quote_no: quote.quote_no,
      name: quote.name,
      expiry: quote.expiry,
      permalink,
      items,
      skipped,
      drift,
      requires_review: drift.length > 0, // >3% drift => interstitial before checkout
      footer: QUOTE_FOOTER.replace("{expiry}", quote.expiry || ""),
    };
  }

  /* ---------- Wave-1: branded quote PDF (P2-3) ---------- */

  /** Partner contact block for the PDF header. Never fails the PDF. */
  async readPartnerForPdf(partnerId) {
    try {
      const rows = await this.axis.read("res.partner", [partnerId], [
        "name", "email", "phone", "street", "street2", "city", "state_id", "zip", "country_id",
      ]);
      if (!rows.length) return {};
      const p = rows[0];
      const addrParts = [
        [p.street, p.street2].filter(Boolean).join(", "),
        [p.city, Array.isArray(p.state_id) ? p.state_id[1] : null, p.zip].filter(Boolean).join(" "),
        Array.isArray(p.country_id) ? p.country_id[1] : null,
      ].filter(Boolean);
      return {
        name: p.name || null,
        email: p.email || null,
        phone: p.phone || null,
        address: addrParts.join(", ") || null,
      };
    } catch (e) {
      console.warn("[pdf] partner read failed (rendering without contact block):", e.message);
      return {};
    }
  }

  /**
   * Owner PDF download: full pricing. `?mode=` is accepted for parity with
   * the Lowe's Download dialog (full | price_only | none) — the owner may
   * deliberately download a masked copy to hand to a client.
   */
  async getQuotePdf(email, ref, { mode = "full" } = {}) {
    if (!["full", "price_only", "none"].includes(mode)) throw badRequest("mode must be full | price_only | none");
    const order = await this.findQuote(email, ref);
    const detail = await this.getQuote(email, order.id, { skipPartnerCheck: true });
    detail.created = order.create_date || null;
    const partner = Array.isArray(order.partner_id)
      ? await this.readPartnerForPdf(order.partner_id[0])
      : {};
    const buffer = pdf.renderQuotePdf({ quote: detail, partner, mode });
    return { buffer, filename: `PES-Quote-${detail.quote_no}.pdf`, mode };
  }

  /**
   * Shared-link PDF: masked per the token's stored mode. A "none" share
   * produces a PDF with NO prices and NO totals anywhere. Preview tokens
   * (P2-9) resolve here too, with the same masking.
   */
  async getSharedQuotePdf(token) {
    let rec = share.lookupToken(token);
    if (!rec) {
      const pv = preview.lookupPreview(token);
      if (pv === "expired") throw notFound("preview link expired (previews last 15 minutes) — open a fresh preview from the quote");
      if (!pv) throw notFound("shared quote not found or link revoked");
      rec = pv;
    }
    const order = await this.findQuote(null, rec.order_id, { skipPartnerCheck: true });
    const detail = await this.getQuote(null, rec.order_id, { skipPartnerCheck: true });
    detail.created = order.create_date || null;
    const partner = Array.isArray(order.partner_id)
      ? await this.readPartnerForPdf(order.partner_id[0])
      : {};
    const buffer = pdf.renderQuotePdf({ quote: detail, partner, mode: rec.mode });
    return { buffer, filename: `PES-Quote-${detail.quote_no}.pdf`, mode: rec.mode };
  }

  /* ---------- Wave-1: day-5-of-7 expiring-quote email sweep ---------- */

  /**
   * Expiring sweep: emails quote owners whose proxy-touched quote expires in
   * exactly 2 days (day 5 of the 7-day hold). GUARDRAIL: only quotes in the
   * local registry (created/touched by this proxy) are considered — Axis
   * holds ~2,800 historical drafts belonging to real customers who must
   * never receive these. Deduped per (order, validity_date) so re-runs and
   * restarts never double-send; an edit that restates validity produces a
   * new dedupe key (correct: a fresh 7-day hold gets a fresh day-5 email).
   * Returns a summary; never throws.
   */
  async sweepExpiringQuotes() {
    const target = todayPlus(2); // day 5 of 7
    const out = { target_date: target, candidates: 0, emailed: 0, deduped: 0, skipped: 0, errors: 0 };
    for (const entry of registry.all()) {
      out.candidates++;
      try {
        const rows = await this.axis.searchRead(
          "sale.order",
          [["id", "=", entry.order_id], ["state", "in", ["draft", "sent"]]],
          ["id", "name", "validity_date"],
          { limit: 1 }
        );
        if (!rows.length || rows[0].validity_date !== target) {
          out.skipped++;
          continue;
        }
        const detail = await this.getQuote(null, entry.order_id, { skipPartnerCheck: true });
        const res = await this.mailer.queue(
          "expiring",
          { email: entry.email, quote: detail },
          { dedupeKey: `expiring:${entry.order_id}:${target}` }
        );
        if (res.status === "deduped") out.deduped++;
        else out.emailed++;
      } catch (e) {
        out.errors++;
        console.warn(`[sweep] order ${entry.order_id}:`, e.message);
      }
    }
    console.log("[sweep] expiring sweep:", JSON.stringify(out));
    return out;
  }

  /* ---------- cache ---------- */

  async refreshCache(email) {
    const { quotes } = await this.listQuotes(email);
    return cache.writeCache(email, quotes);
  }

  /* ---------- helpers ---------- */

  async findPartnerId(email) {
    const found = await this.axis.search("res.partner", [["email", "=ilike", String(email).trim().toLowerCase()]], { limit: 1 });
    return found.length ? found[0] : null;
  }

  async findQuote(email, ref, { skipPartnerCheck = false } = {}) {
    let domain;
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      domain = [["id", "=", Number(ref)]];
    } else {
      // quote number (S...) or job name
      domain = ["|", ["name", "=", String(ref)], ["client_order_ref", "=", String(ref)]];
    }
    if (!skipPartnerCheck) {
      const partnerId = await this.findPartnerId(email);
      if (!partnerId) throw notFound("no Axis partner for this email");
      domain = [...domain, ["partner_id", "=", partnerId]];
    }
    const orders = await this.axis.searchRead(
      "sale.order",
      domain,
      ["id", "name", "client_order_ref", "state", "validity_date", "amount_total", "amount_untaxed", "write_date", "order_line", "pricelist_id", "note", "create_date", "partner_id"],
      { limit: 1 }
    );
    if (!orders.length) throw notFound(`quote not found: ${ref}`);
    return orders[0];
  }

  async findProductBySku(sku) {
    if (!sku) throw badRequest("sku is required");
    const prods = await this.axis.searchRead(
      "product.product",
      [["default_code", "=", String(sku)]],
      ["id", "default_code", "name", "list_price"],
      { limit: 1 }
    );
    if (!prods.length) throw notFound(`SKU not found in Axis: ${sku}`);
    return prods[0];
  }

  async findLineIdBySku(order, sku) {
    if (!order.order_line.length || !sku) return null;
    const lines = await this.axis.read("sale.order.line", order.order_line, ["id", "product_id"]);
    const prodIds = [...new Set(lines.map((l) => l.product_id && l.product_id[0]).filter(Boolean))];
    if (!prodIds.length) return null;
    const prods = await this.axis.read("product.product", prodIds, ["id", "default_code"]);
    const target = prods.find((p) => p.default_code === sku);
    if (!target) return null;
    const line = lines.find((l) => l.product_id && l.product_id[0] === target.id);
    return line ? line.id : null;
  }
}

function cleanName(name) {
  // Product names often embed the SKU as "[SKU] Title" — strip for display.
  return String(name || "").replace(/^\[[^\]]*\]\s*/, "");
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function badRequest(msg) { return new HttpError(400, msg); }
function notFound(msg) { return new HttpError(404, msg); }

module.exports = { QuoteService, HttpError, QUOTE_FOOTER };
