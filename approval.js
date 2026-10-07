"use strict";
/*
 * approval.js — Wave-2B (P2-12) quote approval threshold.
 *
 * When a quote's total crosses QUOTE_APPROVAL_MIN (default $10,000), conversion
 * is gated: the quote enters "pending approval" (proxy-side state + a flag on
 * the Axis sale.order), the approver gets an outbox email with a single-use,
 * 72-hour approve link, and approval marks the quote convertible.
 *
 * FAIL CLOSED, always: approval state for an over-threshold quote is derived
 * from this store; an unreadable/empty/missing store yields "pending" (NOT
 * convertible). There is no code path that treats unknown state as approved.
 *
 * Store: data/quote-approvals.json (container-fs, like share-tokens.json —
 * LOST on container recreation; losing it flips over-threshold quotes back to
 * "pending", which is the fail-safe direction: re-flag + re-email, never
 * accidentally convertible).
 *
 *   {
 *     "orders": { "<orderId>": { state: "pending"|"approved", flagged_total,
 *                                flagged_at, approved_at|null } },
 *     "tokens": { "<sha256hex>": { order_id, expires_at, used } }
 *   }
 *
 * Approve tokens: 32 random bytes base64url (~256 bits); only the SHA-256 of
 * the token is stored, so the store file alone cannot mint approvals.
 * Single-use (used=true after a successful approve) and 72h expiry
 * (env QUOTE_APPROVAL_TOKEN_HOURS, default 72). Expired/used/unknown tokens
 * never mutate state.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "data", "quote-approvals.json");
const TOKEN_TTL_MS =
  Math.max(1, parseFloat(process.env.QUOTE_APPROVAL_TOKEN_HOURS || "72")) * 60 * 60 * 1000;

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (!s || typeof s !== "object") return { orders: {}, tokens: {} };
    if (!s.orders || typeof s.orders !== "object") s.orders = {};
    if (!s.tokens || typeof s.tokens !== "object") s.tokens = {};
    return s;
  } catch {
    return { orders: {}, tokens: {} }; // unreadable => empty => fail closed
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** Over-threshold check. Threshold <= 0 disables the gate entirely. */
function needsApproval(total, min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return false;
  return Number(total) >= m;
}

/**
 * Display/convert state for one order. FAIL CLOSED: an over-threshold quote
 * with no store record reports "pending" (not convertible) — the record (and
 * the approver email) is created on the first conversion attempt.
 */
function infoFor(orderId, total, min) {
  const required = needsApproval(total, min);
  const out = { required, state: "none", threshold: Number(min) || 0 };
  if (!required) return out;
  const rec = loadStore().orders[String(orderId)];
  if (rec && rec.state === "approved") {
    out.state = "approved";
    out.approved_at = rec.approved_at || null;
  } else {
    out.state = "pending"; // rec missing OR pending — both fail closed
    out.flagged_at = rec && rec.flagged_at ? rec.flagged_at : null;
  }
  return out;
}

/**
 * Enter (or report) the pending state for an order. Idempotent: an existing
 * pending record is returned with created:false and NO new token/email — the
 * approver is notified exactly once per pending episode.
 */
function flagPending(orderId, total, now = Date.now()) {
  const store = loadStore();
  const key = String(orderId);
  const existing = store.orders[key];
  if (existing && existing.state === "pending") {
    return { created: false, state: "pending", flagged_at: existing.flagged_at };
  }
  if (existing && existing.state === "approved") {
    return { created: false, state: "approved", approved_at: existing.approved_at };
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const flaggedAt = new Date(now).toISOString();
  store.orders[key] = {
    state: "pending",
    flagged_total: Number(total) || 0,
    flagged_at: flaggedAt,
    approved_at: null,
  };
  store.tokens[hashToken(token)] = {
    order_id: orderId,
    expires_at: new Date(now + TOKEN_TTL_MS).toISOString(),
    used: false,
  };
  saveStore(store);
  return {
    created: true,
    state: "pending",
    flagged_at: flaggedAt,
    token,
    expires_at: new Date(now + TOKEN_TTL_MS).toISOString(),
    ttl_hours: Math.round(TOKEN_TTL_MS / 3600000),
  };
}

/**
 * Consume an approve token. Returns { order_id } on success.
 * Throws Error with .status 404 (unknown), 410 (expired), 409 (already used).
 * State is NEVER mutated on failure (fail closed).
 */
function approveToken(token, now = Date.now()) {
  if (!token || typeof token !== "string") {
    const e = new Error("missing approval token");
    e.status = 400;
    throw e;
  }
  const store = loadStore();
  const rec = store.tokens[hashToken(token)];
  if (!rec) {
    const e = new Error("approval link not recognized — it may have been replaced by a newer one");
    e.status = 404;
    throw e;
  }
  if (rec.used) {
    const e = new Error("this approval link was already used — each link works exactly once");
    e.status = 409;
    throw e;
  }
  if (!rec.expires_at || Date.parse(rec.expires_at) <= now) {
    const e = new Error("this approval link has expired (links are valid for 72 hours) — ask for a fresh approval request");
    e.status = 410;
    throw e;
  }
  rec.used = true;
  store.orders[String(rec.order_id)] = {
    state: "approved",
    flagged_total: store.orders[String(rec.order_id)]
      ? store.orders[String(rec.order_id)].flagged_total
      : null,
    flagged_at: store.orders[String(rec.order_id)]
      ? store.orders[String(rec.order_id)].flagged_at
      : null,
    approved_at: new Date(now).toISOString(),
  };
  saveStore(store);
  return { order_id: rec.order_id };
}

/** Drop all state for a deleted order (same lifecycle as share tokens). */
function purgeOrder(orderId) {
  const store = loadStore();
  let dropped = 0;
  if (store.orders[String(orderId)]) {
    delete store.orders[String(orderId)];
    dropped++;
  }
  for (const h of Object.keys(store.tokens)) {
    if (store.tokens[h].order_id === orderId) {
      delete store.tokens[h];
      dropped++;
    }
  }
  if (dropped) saveStore(store);
  return dropped;
}

module.exports = { STORE_PATH, needsApproval, infoFor, flagPending, approveToken, purgeOrder };
