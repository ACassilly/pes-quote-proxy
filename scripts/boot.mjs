/*
 * scripts/boot.mjs — container bootstrap (Azure Container Instances deploy).
 *
 * 1. Seeds web/data/sku-variant-map.json from the PUBLIC Shopify storefront
 *    (/products.json pagination — no credentials required), using the same
 *    mapping logic as scripts/seed-sku-map.mjs.
 * 2. Starts server.js.
 *
 * If the storefront fetch fails the server still starts with an empty map
 * (convert fails loudly per spec; /healthz reports sku_map.entries so the
 * failure is visible). The server hot-reloads the map on mtime change, so a
 * later successful seed (manual or nightly job) takes effect without restart.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOP = (process.env.SHOP_STOREFRONT || "https://www.portlandiaelectric.supply").replace(/\/+$/, "");
const LIMIT = 250;
const MAX_PAGES = 80; // safety cap: 20k products

const FREIGHT_RE = /pallet|freight/i;

async function fetchAllProducts() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${SHOP}/products.json?limit=${LIMIT}&page=${page}`, {
      headers: { "User-Agent": "pes-quote-proxy-boot/1.0" },
    });
    if (!res.ok) throw new Error(`storefront products.json page ${page}: HTTP ${res.status}`);
    const data = await res.json();
    const products = data.products || [];
    all.push(...products);
    console.log(`boot: fetched page ${page} (${products.length} products, total ${all.length})`);
    if (products.length < LIMIT) break;
  }
  return all;
}

function buildMap(products) {
  const map = {};
  for (const p of products) {
    const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",").map((t) => t.trim());
    const freight = tags.some((t) => FREIGHT_RE.test(t));
    for (const v of p.variants || []) {
      if (!v.sku) continue;
      map[v.sku] = {
        variant_id: v.id,
        shopify_price: parseFloat(v.price),
        title: v.title && v.title !== "Default Title" ? `${p.title} — ${v.title}` : p.title,
        handle: p.handle,
        freight,
      };
    }
  }
  return map;
}

try {
  const products = await fetchAllProducts();
  const map = buildMap(products);
  const out = path.join(root, "data", "sku-variant-map.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(map));
  console.log(`boot: wrote ${Object.keys(map).length} SKU mappings -> ${out}`);
} catch (e) {
  console.error("boot: SKU map seed failed, starting with existing/empty map:", e.message);
}

await import(path.join(root, "server.js"));
