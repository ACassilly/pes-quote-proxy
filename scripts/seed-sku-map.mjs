/*
 * seed-sku-map.mjs — build web/data/sku-variant-map.json from a storefront
 * products export (all_products.json shape: Shopify /products.json pages).
 *
 * Usage:  node scripts/seed-sku-map.mjs <path-to-products.json> [...more.json]
 *
 * Nightly refresh (deploy): swap the file inputs for Admin API
 * /admin/api/2026-07/products.json pagination and run from cron; the convert
 * endpoint hot-reloads the file on mtime change.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outPath = path.join(root, "data", "sku-variant-map.json");

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("usage: node scripts/seed-sku-map.mjs <products.json> [...]");
  process.exit(1);
}

const FREIGHT_RE = /pallet|freight/i;
const map = {};

for (const file of inputs) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const products = Array.isArray(data) ? data : data.products || [];
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
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(map));
console.log(`wrote ${Object.keys(map).length} SKU mappings -> ${outPath}`);
