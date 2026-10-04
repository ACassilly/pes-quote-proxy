"use strict";
/*
 * sku-map.js — SKU -> Shopify variant mapping for quote->cart conversion.
 *
 * The table lives at web/data/sku-variant-map.json:
 *   { "SKU": { "variant_id": 44187793293446, "shopify_price": 1455.00,
 *              "title": "...", "handle": "...", "freight": false } }
 *
 * It is refreshed nightly from the Admin API (see scripts/seed-sku-map.mjs for
 * the seed generator; the nightly job uses the same code path). Convert
 * behavior per spec §7: unmapped SKUs fail LOUDLY (line skipped with notice),
 * never silently. Freight/pallet items are flagged `freight: true` and are
 * excluded from the price-lock language (owner default: freight items
 * excluded from price lock).
 */

const fs = require("fs");
const path = require("path");

const MAP_PATH = path.join(__dirname, "data", "sku-variant-map.json");

let map = null;
let mtime = 0;

function loadMap() {
  try {
    const st = fs.statSync(MAP_PATH);
    if (!map || st.mtimeMs !== mtime) {
      map = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
      mtime = st.mtimeMs;
    }
  } catch {
    map = map || {};
  }
  return map;
}

function lookup(sku) {
  if (!sku) return null;
  const m = loadMap();
  return m[sku] || m[String(sku).toUpperCase()] || null;
}

function stats() {
  const m = loadMap();
  return { entries: Object.keys(m).length, path: MAP_PATH };
}

module.exports = { lookup, stats, MAP_PATH };
