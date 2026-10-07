"use strict";
/*
 * share.js — shareable quote links with price masking (P1).
 *
 * Lowe's deep-pass finding #6: a contractor can forward a quote to their
 * client with one of three price-visibility modes, deliberately hiding
 * margin/cost structure:
 *
 *   full        "Price and Discounts"  — quoted unit price, per-line savings
 *                                        vs list, totals.
 *   price_only  "Price Only"           — retail (list) unit price, totals at
 *                                        list; NO discount/savings fields.
 *   none        "No Price"             — names, SKUs, quantities only; every
 *                                        price/total field stripped.
 *
 * Token model:
 *   - token = 32 random bytes, base64url (unguessable, ~256 bits entropy).
 *   - token is tied to the Axis sale.order id (never to the partner).
 *   - store = data/share-tokens.json (proxy-side state, like the SKU map —
 *     avoids unapproved Axis schema writes). Revocation marks revoked=true
 *     and keeps the audit row; regenerating a link revokes prior tokens for
 *     that order. P2 may move this to an Axis x_ field once schema writes
 *     are approved.
 *   - recipient hits GET /proxy/quotes/shared/:token with NO email/auth —
 *     the token IS the capability. That is the intended no-auth-wall flow.
 *
 * maskQuote() is a pure function (unit-tested without Axis).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "data", "share-tokens.json");

const SHARE_MODES = ["full", "price_only", "none"];

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

/** Create a share token. Regenerating revokes existing live tokens for the order. */
function createShare({ orderId, quoteNo, mode, note }) {
  if (!SHARE_MODES.includes(mode)) {
    const e = new Error(`mode must be one of: ${SHARE_MODES.join(", ")}`);
    e.status = 400;
    throw e;
  }
  const store = loadStore();
  for (const t of Object.keys(store)) {
    if (store[t].order_id === orderId && !store[t].revoked) store[t].revoked = true;
  }
  const token = newToken();
  store[token] = {
    order_id: orderId,
    quote_no: quoteNo || null,
    mode,
    note: note ? String(note).slice(0, 500) : null,
    created_at: new Date().toISOString(),
    revoked: false,
  };
  saveStore(store);
  return { token, mode, share_path: `/pages/shared-quote?token=${token}` };
}

/** Revoke one token, or every token for an order when token is omitted. */
function revokeShare({ orderId, token }) {
  const store = loadStore();
  let count = 0;
  if (token) {
    if (store[token] && !store[token].revoked) {
      store[token].revoked = true;
      count = 1;
    }
  } else {
    for (const t of Object.keys(store)) {
      if (store[t].order_id === orderId && !store[t].revoked) {
        store[t].revoked = true;
        count++;
      }
    }
  }
  saveStore(store);
  return count;
}

function lookupToken(token) {
  const store = loadStore();
  const rec = store[token];
  if (!rec || rec.revoked) return null;
  return rec;
}

/** Drop all store rows pointing at a deleted order. */
function purgeOrder(orderId) {
  const store = loadStore();
  let dropped = 0;
  for (const t of Object.keys(store)) {
    if (store[t].order_id === orderId) {
      delete store[t];
      dropped++;
    }
  }
  if (dropped) saveStore(store);
  return dropped;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Pure masking. Input = quote detail payload whose lines carry
 * {title, sku, qty, unit_price, line_total, list_price, savings_pct}.
 * Returns a NEW payload shaped for the given mode; the input is untouched.
 * In mode "none" no numeric price field survives anywhere in the payload.
 */
function maskQuote(quote, mode) {
  if (!SHARE_MODES.includes(mode)) throw new Error(`unknown share mode: ${mode}`);

  const baseLines = (quote.lines || []).map((l) => ({
    title: l.title,
    sku: l.sku,
    // NOTE: customer_sku (Wave-2B #109) is deliberately NOT carried into the
    // "none" base shape — mode=none payloads are pinned to exactly
    // {title, sku, qty} per line (masking invariant, unit-tested).
    qty: l.qty,
  }));

  let lines;
  let totals = {};
  if (mode === "full") {
    lines = (quote.lines || []).map((l) => ({
      title: l.title,
      sku: l.sku,
      customer_sku: l.customer_sku || null,
      qty: l.qty,
      unit_price: l.unit_price,
      line_total: l.line_total,
      list_price: l.list_price != null ? l.list_price : null,
      savings_pct: l.savings_pct != null ? l.savings_pct : null,
    }));
    totals = {
      total: quote.total,
      total_list: round2(
        (quote.lines || []).reduce((s, l) => s + (l.list_price != null ? l.list_price : l.unit_price) * l.qty, 0)
      ),
    };
  } else if (mode === "price_only") {
    // Retail price, no discounts: unit price shown at list; no savings fields.
    lines = (quote.lines || []).map((l) => {
      const retail = l.list_price != null ? l.list_price : l.unit_price;
      return {
        title: l.title,
        sku: l.sku,
        customer_sku: l.customer_sku || null,
        qty: l.qty,
        unit_price: retail,
        line_total: round2(retail * l.qty),
      };
    });
    totals = {
      total: round2(lines.reduce((s, l) => s + l.line_total, 0)),
    };
  } else {
    lines = baseLines;
    totals = {}; // no total, no untaxed, nothing numeric about price
  }

  return {
    quote_no: quote.quote_no,
    name: quote.name,
    expiry: quote.expiry,
    expires_in_days: quote.expires_in_days,
    expired: quote.expired,
    mode,
    lines,
    ...totals,
    footer: quote.footer,
  };
}

module.exports = {
  SHARE_MODES,
  createShare,
  revokeShare,
  lookupToken,
  purgeOrder,
  maskQuote,
};
