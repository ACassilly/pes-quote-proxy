"use strict";
/*
 * preview.js — Wave-1 (P2-9 BEAT) "Preview as client" ephemeral preview tokens.
 *
 * Lowe's definitively has no preview-as-recipient (pass 4): "The only way to
 * see what a client receives is to send." Ours lets the contractor open the
 * exact recipient view (the P1 shared-quote page) in a chosen masking mode
 * WITHOUT creating or touching a real share link.
 *
 * Model:
 *   - SEPARATE store file data/preview-tokens.json — real share tokens
 *     (data/share-tokens.json) are never read, written, revoked, or listed by
 *     this module. Creating a preview cannot invalidate a live share link.
 *   - token = 32 random bytes base64url (same 256-bit shape as share tokens);
 *     TTL = 15 minutes from creation (env PREVIEW_TTL_MINUTES override).
 *     Expired rows are pruned lazily on every access.
 *   - Preview tokens are resolved by GET /proxy/quotes/shared/:token AFTER the
 *     real share-token lookup misses, so the recipient view is byte-identical
 *     (same masking via share.maskQuote). The payload carries preview:true +
 *     preview_expires_at so the theme can show a "Preview" banner.
 *   - Preview tokens are purged with the quote on delete, same as share tokens.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { SHARE_MODES } = require("./share");

const STORE_PATH = path.join(__dirname, "data", "preview-tokens.json");
const TTL_MS = Math.max(1, parseInt(process.env.PREVIEW_TTL_MINUTES || "15", 10)) * 60 * 1000;

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

function prune(store, now) {
  let dropped = 0;
  for (const t of Object.keys(store)) {
    if (!store[t] || !store[t].expires_at || Date.parse(store[t].expires_at) <= now) {
      delete store[t];
      dropped++;
    }
  }
  return dropped;
}

/**
 * Create an ephemeral preview token. Never touches the share-token store, so
 * existing share links for the same quote keep working.
 */
function createPreview({ orderId, quoteNo, mode, note, now = Date.now() }) {
  if (!SHARE_MODES.includes(mode)) {
    const e = new Error(`mode must be one of: ${SHARE_MODES.join(", ")}`);
    e.status = 400;
    throw e;
  }
  const store = loadStore();
  if (prune(store, now)) { /* pruned below on save */ }
  const token = crypto.randomBytes(32).toString("base64url");
  const created = new Date(now).toISOString();
  const expires = new Date(now + TTL_MS).toISOString();
  store[token] = {
    order_id: orderId,
    quote_no: quoteNo || null,
    mode,
    note: note ? String(note).slice(0, 500) : null,
    created_at: created,
    expires_at: expires,
  };
  saveStore(store);
  return {
    token,
    mode,
    expires_at: expires,
    ttl_minutes: Math.round(TTL_MS / 60000),
    preview_path: `/pages/shared-quote?token=${token}`,
  };
}

/**
 * Look up a live preview token. Returns the record, the string "expired"
 * when the token exists but its TTL has elapsed, or null when unknown.
 */
function lookupPreview(token, now = Date.now()) {
  const store = loadStore();
  const rec = store[token];
  if (!rec) return null;
  if (!rec.expires_at || Date.parse(rec.expires_at) <= now) {
    if (prune(store, now)) saveStore(store);
    return "expired";
  }
  return rec;
}

/** Drop all preview rows pointing at a deleted order. */
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

module.exports = { STORE_PATH, TTL_MS, createPreview, lookupPreview, purgeOrder };
