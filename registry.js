"use strict";
/*
 * registry.js — local registry of quotes created/touched by the proxy.
 *
 * Why this exists: Axis holds ~2,800 historical draft sale.orders belonging
 * to real customers. The day-5-of-7 expiring-quote email sweep must NEVER
 * email those historical customers — it only considers quotes the proxy
 * itself has seen (created or mutated through the storefront flow). The
 * registry is that guardrail. It lives proxy-side (data/known-quotes.json),
 * same pattern as the share-token store.
 */

const fs = require("fs");
const path = require("path");

const REG_PATH = path.join(__dirname, "data", "known-quotes.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(REG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(reg) {
  fs.mkdirSync(path.dirname(REG_PATH), { recursive: true });
  const tmp = REG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REG_PATH);
}

/**
 * Record (or refresh) a quote the proxy has touched.
 * Wave-2A: `convertedAt` marks the moment a quote was converted to a cart —
 * that is what the job-scoped reorder surface (reorder.js) lists as a "past
 * converted quote". A later plain record never clears a prior converted_at.
 */
function record({ orderId, email, quoteNo, name, validityDate, convertedAt }) {
  const reg = load();
  const prev = reg[String(orderId)] || {};
  reg[String(orderId)] = {
    email: String(email || "").toLowerCase(),
    quote_no: quoteNo || null,
    name: name || null,
    validity_date: validityDate || null,
    converted_at: convertedAt || prev.converted_at || null,
    touched_at: new Date().toISOString(),
  };
  save(reg);
}

function remove(orderId) {
  const reg = load();
  if (reg[String(orderId)]) {
    delete reg[String(orderId)];
    save(reg);
  }
}

function all() {
  return Object.entries(load()).map(([id, r]) => ({ order_id: Number(id), ...r }));
}

module.exports = { record, remove, all };
