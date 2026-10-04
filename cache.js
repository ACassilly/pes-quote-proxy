"use strict";
/*
 * cache.js — customer quote-cache writer.
 *
 * SPEC (§2): after every Axis write, the proxy writes a compact JSON snapshot
 * to the customer metafield `pes.quotes_cache`:
 *   [{name, quote_no, total, expiry, updated_at, line_count}]
 * The theme drawer and /pages/quotes render instantly from that metafield.
 *
 * P0 STATUS: **STUBBED.** This app currently has no Shopify Admin API token
 * wired in (Partner credentials are pending and the order-status app is
 * extension-only). The stub writes the exact payload shape to
 * web/data/quotes-cache/<sha256(email)>.json and logs a clear TODO marker.
 * Swap `writeCache()` internals for a single Admin API call once creds land:
 *
 *   PUT /admin/api/2026-07/customers/{customer_id}/metafields/{id}.json
 *   { metafield: { namespace: "pes", key: "quotes_cache",
 *                  type: "json", value: JSON.stringify(summaries) } }
 *
 * Guest quotes (email-capture, no Shopify customer) have no metafield target;
 * their cache entry stays proxy-side only — the drawer reads guests' quotes
 * live via GET /proxy/quotes?email=… anyway.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = path.join(__dirname, "data", "quotes-cache");

function cachePathFor(email) {
  const key = crypto.createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 24);
  return path.join(CACHE_DIR, `${key}.json`);
}

/**
 * @param {string} email      customer email (cache identity)
 * @param {Array}  summaries  [{name, quote_no, total, expiry, updated_at, line_count}]
 */
function writeCache(email, summaries) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const payload = {
    stub: true, // TODO(deploy): replace with Admin API customer metafield pes.quotes_cache write
    email: String(email).toLowerCase(),
    updated_at: new Date().toISOString(),
    quotes: summaries,
  };
  fs.writeFileSync(cachePathFor(email), JSON.stringify(payload, null, 2));
  console.log(`[cache] STUB wrote ${summaries.length} quote summaries for ${email} (metafield write pending Admin creds)`);
  return payload;
}

function readCache(email) {
  try {
    return JSON.parse(fs.readFileSync(cachePathFor(email), "utf8"));
  } catch {
    return null;
  }
}

module.exports = { writeCache, readCache };
