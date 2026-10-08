"use strict";
/*
 * approval.js — Wave-2B flag store.
 *
 * OWNER RULING 2026-10-08: "They get flagged for additional attention from our
 * staff — on Intercom, ERP, and sales channel — but NEVER blocked."
 *
 * This module used to implement a conversion GATE (pending_approval, approve
 * tokens). That semantics is RETIRED. What remains is a FLAG: when a quote's
 * total reaches QUOTE_FLAG_MIN (env; legacy name QUOTE_APPROVAL_MIN still
 * honored; default $10,000), the quote is recorded here as flagged and the
 * proxy fans out staff notifications (Axis activity/tag, Intercom, outbox
 * email, Shopify cart attributes). CONVERSION IS NEVER BLOCKED — a flagged
 * quote converts exactly like any other.
 *
 * The single-use approve-token machinery is DROPPED (no longer issued; the
 * /approve endpoint returns 410 Gone). Fail-safe direction flipped with the
 * semantics: an unreadable store now means "no flag yet", never a block —
 * there is no blocking state left to fail closed into.
 *
 * Store: data/quote-approvals.json (container-fs, like share-tokens.json —
 * lost on container group recreation; losing flags only loses the staff
 * notification audit trail, never a customer capability).
 *
 *   { "orders": { "<orderId>": { flagged: true, flagged_total, flagged_at } } }
 */

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "data", "quote-approvals.json");

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (!s || typeof s !== "object") return { orders: {} };
    if (!s.orders || typeof s.orders !== "object") s.orders = {};
    return s;
  } catch {
    return { orders: {} };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

/** Over-threshold check. Threshold <= 0 disables flagging entirely. */
function needsApproval(total, min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return false;
  return Number(total) >= m;
}

/**
 * Flag state for one order: {required, flagged, flagged_at, threshold}.
 * required = total crosses the threshold; flagged = staff notification has
 * been recorded. Neither state ever blocks conversion.
 */
function infoFor(orderId, total, min) {
  const required = needsApproval(total, min);
  const out = { required, flagged: false, flagged_at: null, threshold: Number(min) || 0 };
  if (!required) return out;
  const rec = loadStore().orders[String(orderId)];
  if (rec && rec.flagged) {
    out.flagged = true;
    out.flagged_at = rec.flagged_at || null;
  }
  return out;
}

/**
 * Record the flag for an order. Idempotent: a second call returns
 * created:false so the notification fan-out fires exactly once per episode.
 * NEVER throws on store write failure (a flag must never break a convert) —
 * the caller logs and proceeds.
 */
function flagForReview(orderId, total) {
  const store = loadStore();
  const key = String(orderId);
  const existing = store.orders[key];
  if (existing && existing.flagged) {
    return { created: false, flagged: true, flagged_at: existing.flagged_at };
  }
  const flaggedAt = new Date().toISOString();
  store.orders[key] = {
    flagged: true,
    flagged_total: Number(total) || 0,
    flagged_at: flaggedAt,
  };
  saveStore(store);
  return { created: true, flagged: true, flagged_at: flaggedAt };
}

/** Drop flag state for a deleted order (same lifecycle as share tokens). */
function purgeOrder(orderId) {
  const store = loadStore();
  let dropped = 0;
  if (store.orders[String(orderId)]) {
    delete store.orders[String(orderId)];
    dropped++;
  }
  if (dropped) saveStore(store);
  return dropped;
}

module.exports = { STORE_PATH, needsApproval, infoFor, flagForReview, purgeOrder };
