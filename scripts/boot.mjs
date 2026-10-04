/*
 * scripts/boot.mjs — container bootstrap (Azure Container Instances deploy).
 *
 * 1. Starts server.js immediately (health endpoint live within seconds).
 * 2. In the background, seeds data/sku-variant-map.json from the PUBLIC
 *    Shopify storefront (/products.json pagination — no credentials), same
 *    mapping logic as scripts/seed-sku-map.mjs. The map is built page by
 *    page (catalog is large; full product payloads are never held in memory).
 *
 * The server hot-reloads the map on mtime change, so once the seed write
 * lands, convert/add-by-SKU pick it up without a restart. Until then
 * /healthz reports sku_map.entries and convert fails loudly per spec.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOP = (process.env.SHOP_STOREFRONT || "https://www.portlandiaelectric.supply").replace(/\/+$/, "");
const LIMIT = 250;
const MAX_PAGES = 120; // safety cap: 30k products
const FREIGHT_RE = /pallet|freight/i;

function addPage(map, products) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeMap(map) {
  const out = path.join(root, "data", "sku-variant-map.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(map));
  fs.renameSync(tmp, out);
}

async function seedMapOnce() {
  const map = {};
  let page = 1;
  try {
    for (; page <= MAX_PAGES; page++) {
      const res = await fetch(`${SHOP}/products.json?limit=${LIMIT}&page=${page}`, {
        headers: { "User-Agent": "pes-quote-proxy-boot/1.0" },
      });
      if (!res.ok) throw new Error(`storefront products.json page ${page}: HTTP ${res.status}`);
      const data = await res.json();
      const products = data.products || [];
      addPage(map, products);
      console.log(`boot: page ${page}: ${products.length} products, ${Object.keys(map).length} SKUs so far`);
      if (page % 10 === 0) writeMap(map); // checkpoint: partial map goes live every 10 pages
      if (products.length < LIMIT) break;
      await sleep(900); // be polite to the storefront (429s observed at ~400ms)
    }
  } finally {
    // Even on failure (e.g. 429 partway), publish what we have — a partial
    // map beats an empty one; a later attempt's fuller map overwrites it.
    if (Object.keys(map).length) writeMap(map);
  }
  console.log(`boot: wrote ${Object.keys(map).length} SKU mappings (last page ${page})`);
}

async function seedMapWithRetry() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await seedMapOnce();
      return;
    } catch (e) {
      console.error(`boot: SKU map seed attempt ${attempt} failed:`, e.message);
      if (attempt < 3) await sleep(60000);
    }
  }
  console.error("boot: SKU map seed gave up; server continues with existing/empty map (healthz shows entries)");
}

// 1) start the server first so /healthz answers during seeding
await import(path.join(root, "server.js"));

// 2) seed in the background; failures never take the server down
seedMapWithRetry();
