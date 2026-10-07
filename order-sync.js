"use strict";
/*
 * order-sync.js — Stitch 2: live Shopify orders -> Axis (Odoo 19) sale.order.
 *
 * Poll-based ingest (no public webhook endpoint needed):
 *   every ORDER_SYNC_INTERVAL_MIN minutes, Admin API
 *     GET /admin/api/2026-07/orders.json?updated_at_min=<checkpoint>&status=any
 *   upserts into Axis as sale.order with External ID `pes_order_<shopify_order_id>`
 *   (lines: `pes_line_<order_id>_<line_item_id>`) via the Odoo external API
 *   load() — the exact idempotent upsert pattern proven by the erp-backfill
 *   import_riven.py run against this same Axis build. Re-running never
 *   duplicates; it updates in place.
 *
 * State map (authorize-after-confirm model — NEVER auto-confirm uncaptured):
 *   Shopify cancelled_at set                -> action_cancel  (state=cancel)
 *   financial_status paid|partially_paid    -> action_confirm (state=sale)
 *   financial_status authorized|pending|…   -> stays draft + pes_sync tag + note
 *                                              "authorized, awaiting confirmation"
 *   financial_status refunded|partially_…   -> note records refund (state kept)
 * The deterministic note is rewritten every cycle (idempotent same-value write).
 *
 * Customer map: order.email / customer.email -> res.partner (same =ilike
 * resolution pattern as quotes.js resolvePartner; Shopify customer id in ref).
 *
 * Line map: SKU -> product.product by default_code (quote-proxy pattern).
 * Misses go LOUDLY to the dead-letter log (data/order-sync-deadletter.jsonl +
 * in-memory ring + console) — never silent-skipped. The order still syncs with
 * its resolvable lines; the note flags the dead-lettered lines.
 *
 * Known gap (same as backfill gap C): shipping/tax/discounts are NOT lines, so
 * Axis amount_total = line sum, not the Shopify checkout total. The Shopify
 * total travels in the note as the authoritative figure.
 *
 * Checkpoint: data/order-sync-checkpoint.json (container filesystem — survives
 * in-place restarts, lost on group recreation, like share-tokens; recreation
 * simply re-syncs from ORDER_SYNC_SINCE, which is idempotent by design).
 *
 * PII: logs and the dead-letter file contain order ids/names and
 * sha256(email)[:12] only — never raw emails or customer names.
 * Secrets: Shopify token minted via client_credentials (env SHOPIFY_CLIENT_ID +
 * SHOPIFY_APP_SECRET, the app client secret) and held in memory only; Axis key
 * never leaves the AxisClient. Nothing secret is written to disk.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const CHECKPOINT_FILE = path.join(DATA_DIR, "order-sync-checkpoint.json");
const DEADLETTER_FILE = path.join(DATA_DIR, "order-sync-deadletter.jsonl");

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const DEFAULT_SINCE = process.env.ORDER_SYNC_SINCE || "2026-08-01T00:00:00Z";
const SYNC_TAG = "pes_sync";
const XID_ORDER = (id) => `pes_order_${id}`;
const XID_LINE = (oid, lid) => `pes_line_${oid}_${lid}`;

const CAPTURED = new Set(["paid", "partially_paid"]);
const REFUNDED = new Set(["refunded", "partially_refunded"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emailHash = (e) => crypto.createHash("sha256").update(String(e).toLowerCase().trim()).digest("hex").slice(0, 12);

function toOdooDateTime(iso) {
  // "2026-08-06T15:13:09-04:00" -> "2026-08-06 19:13:09" (UTC, Odoo convention)
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

/* ---------------- Shopify Admin API (client_credentials, in-memory token) ---------------- */

class ShopifyAdmin {
  constructor({ shopDomain, clientId, clientSecret, staticToken }) {
    this.shop = shopDomain;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = staticToken || null; // staticToken: local/dev override only
    this.tokenExp = 0;
  }

  async _mint() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(`https://${this.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`Shopify token mint failed: HTTP ${res.status}`);
    const data = await res.json();
    this.token = data.access_token; // memory only — never logged, never persisted
    this.tokenExp = Date.now() + (Number(data.expires_in) - 300) * 1000;
  }

  async _ensureToken() {
    if (!this.token || Date.now() >= this.tokenExp) await this._mint();
  }

  async get(pathWithQuery, { retried401 = false, attempts = 4 } = {}) {
    await this._ensureToken();
    const res = await fetch(`https://${this.shop}/admin/api/${API_VERSION}/${pathWithQuery}`, {
      headers: { "X-Shopify-Access-Token": this.token },
    });
    if (res.status === 401 && !retried401 && this.clientId) {
      this.token = null; // force re-mint once
      return this.get(pathWithQuery, { retried401: true, attempts });
    }
    if (res.status === 429 && attempts > 0) {
      const wait = (parseFloat(res.headers.get("retry-after") || "2") + Math.random()) * 1000;
      await sleep(wait);
      return this.get(pathWithQuery, { retried401, attempts: attempts - 1 });
    }
    if (!res.ok) throw new Error(`Shopify ${pathWithQuery}: HTTP ${res.status}`);
    const link = res.headers.get("link") || "";
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    return { data: await res.json(), nextUrl: next ? next[1] : null };
  }

  /** All orders updated since `sinceIso`, oldest-update first. */
  async fetchOrdersSince(sinceIso) {
    const orders = [];
    let url = `orders.json?status=any&limit=250&order=updated_at+asc&updated_at_min=${encodeURIComponent(sinceIso)}`;
    let fullUrl = null;
    for (let page = 0; page < 40; page++) {
      const { data, nextUrl } = await this.get(fullUrl ? fullUrl.replace(`https://${this.shop}/admin/api/${API_VERSION}/`, "") : url);
      orders.push(...(data.orders || []));
      if (!nextUrl) break;
      fullUrl = nextUrl;
      await sleep(500); // stay well under the leaky bucket
    }
    return orders;
  }
}

/* ---------------- Order sync service ---------------- */

class OrderSyncService {
  constructor(axis, cfg) {
    this.axis = axis;
    this.cfg = cfg;
    this.shopify = new ShopifyAdmin({
      shopDomain: cfg.shopify.shopDomain,
      clientId: process.env.SHOPIFY_CLIENT_ID || null,
      clientSecret: process.env.SHOPIFY_APP_SECRET || null, // app client secret == oauth client secret
      staticToken: process.env.SHOPIFY_ADMIN_TOKEN || null, // dev override; not used in the deploy
    });
    this.dryRun = /^(1|true|yes)$/i.test(process.env.ORDER_SYNC_DRY_RUN || "");
    this.running = false;
    this.tagId = null;
    this.deadletters = []; // in-memory ring (last 200)
    this.lastRun = null;
    this.timer = null;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* read-only fs: status still works */ }
  }

  configured() {
    return !!(this.shopify.clientId && this.shopify.clientSecret) || !!this.shopify.token;
  }

  _deadletter(entry) {
    const rec = { ts: new Date().toISOString(), ...entry };
    this.deadletters.push(rec);
    if (this.deadletters.length > 200) this.deadletters.shift();
    console.warn("[order-sync] DEAD-LETTER", JSON.stringify(rec));
    // Dry-run dead-letters stay in-memory/console only — the JSONL file is the
    // record of REAL sync failures.
    if (!this.dryRun) {
      try { fs.appendFileSync(DEADLETTER_FILE, JSON.stringify(rec) + "\n"); } catch { /* ephemeral fs */ }
    }
  }

  readCheckpoint() {
    try {
      const d = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
      if (d && d.updated_at_min) return d.updated_at_min;
    } catch { /* missing or corrupt -> default */ }
    return DEFAULT_SINCE;
  }

  writeCheckpoint(updatedAtMin) {
    try {
      const tmp = CHECKPOINT_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ updated_at_min: updatedAtMin, saved_at: new Date().toISOString() }));
      fs.renameSync(tmp, CHECKPOINT_FILE);
    } catch (e) {
      console.warn("[order-sync] checkpoint write failed:", e.message);
    }
  }

  async ensureTag() {
    if (this.tagId) return this.tagId;
    const found = await this.axis.search("crm.tag", [["name", "=", SYNC_TAG]], { limit: 1 });
    if (found.length) {
      this.tagId = found[0];
    } else if (this.dryRun) {
      this.tagId = -1; // placeholder; no create in dry-run
    } else {
      this.tagId = await this.axis.create("crm.tag", { name: SYNC_TAG, color: 5 });
    }
    return this.tagId;
  }

  /* Partner resolution: per-email =ilike lookup + create-if-missing — the exact
   * quotes.js resolvePartner pattern. (Odoo =ilike does not accept a list, so
   * no batch shortcut; catch-up volume is ~100 one-time calls, steady state ~0-3.) */
  async resolvePartners(orders) {
    const byEmail = new Map(); // email -> {id, created?}
    const wanted = new Map(); // email -> {name, customerId}
    for (const o of orders) {
      const email = String(o.email || (o.customer && o.customer.email) || "").trim().toLowerCase();
      if (!email) continue;
      const cust = o.customer || {};
      const name = [cust.first_name, cust.last_name].filter(Boolean).join(" ").trim() || email;
      wanted.set(email, { name, customerId: cust.id || null });
    }
    for (const [email, meta] of wanted) {
      const found = await this.axis.searchRead("res.partner", [["email", "=ilike", email]], ["id", "ref"], { limit: 1 });
      if (found.length) {
        const p = found[0];
        if (meta.customerId && !p.ref && !this.dryRun) {
          await this.axis.write("res.partner", [p.id], { ref: `shopify_customer_${meta.customerId}` });
        }
        byEmail.set(email, { id: p.id });
        continue;
      }
      if (this.dryRun) {
        byEmail.set(email, { id: -1, created: true });
        continue;
      }
      const vals = { name: meta.name, email, customer_rank: 1 };
      if (meta.customerId) vals.ref = `shopify_customer_${meta.customerId}`;
      const id = await this.axis.create("res.partner", vals);
      byEmail.set(email, { id, created: true });
    }
    return byEmail;
  }

  async resolveProducts(orders) {
    const skus = new Set();
    for (const o of orders) for (const li of o.line_items || []) {
      if (li.sku) skus.add(String(li.sku));
    }
    const bySku = new Map();
    const list = [...skus];
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      // NB: Axis has DUPLICATE default_code across variant rows (e.g. 9 rows
      // for USS-SUNM-SMR100), so matches >> chunk length — a tight limit here
      // silently truncates SKUs out of the map (observed in the 2026-10-07
      // dry-run). High limit + deterministic lowest-id pick per SKU.
      const rows = await this.axis.searchRead(
        "product.product", [["default_code", "in", chunk]], ["id", "default_code", "name"],
        { limit: 10000, order: "id asc" }
      );
      for (const r of rows) {
        if (!bySku.has(r.default_code)) bySku.set(r.default_code, { id: r.id, name: r.name });
      }
    }
    return bySku;
  }

  composeNote(order, deadLines) {
    const fs0 = order.financial_status || "unknown";
    const parts = [];
    if (order.cancelled_at) {
      parts.push(`PES sync: CANCELLED on Shopify at ${order.cancelled_at} (financial_status=${fs0}).`);
    } else if (CAPTURED.has(fs0)) {
      parts.push(`PES sync: payment captured (financial_status=${fs0}) — confirmed sales order.`);
    } else {
      parts.push(`PES sync: authorized, awaiting confirmation (financial_status=${fs0}). Do NOT fulfill before capture.`);
    }
    if (REFUNDED.has(fs0)) parts.push(`REFUNDED on Shopify (financial_status=${fs0}) — reconcile before fulfillment.`);
    parts.push(`Shopify total ${order.total_price} ${order.currency} (incl. ${order.total_tax} tax / shipping) is authoritative; Axis untaxed = line sum and Axis total may add Axis-computed tax (shipping/tax not synced as lines).`);
    if (deadLines.length) parts.push(`WARNING: ${deadLines.length} line(s) dead-lettered (SKU not in Axis) — see order-sync dead-letter log.`);
    return "<p>" + parts.join("<br/>") + "</p>";
  }

  /** Sync one order. Returns a per-order outcome record (no PII). */
  async syncOrder(order, partners, products) {
    const oid = order.id;
    const name = order.name;
    const email = String(order.email || (order.customer && order.customer.email) || "").trim().toLowerCase();
    const out = { order_id: oid, name, email_hash: email ? emailHash(email) : null, actions: [] };

    if (!email) {
      this._deadletter({ order_id: oid, name, reason: "no email on order — cannot resolve partner" });
      out.actions.push("deadletter:no-email");
      return out;
    }
    const partner = partners.get(email);
    if (!partner) {
      this._deadletter({ order_id: oid, name, email_hash: emailHash(email), reason: "partner resolution failed" });
      out.actions.push("deadletter:partner");
      return out;
    }

    // --- lines: resolve SKUs, dead-letter misses loudly ---
    const deadLines = [];
    const lineRows = [];
    for (const li of order.line_items || []) {
      const sku = li.sku ? String(li.sku) : null;
      const prod = sku ? products.get(sku) : null;
      if (!prod) {
        deadLines.push({ sku, qty: li.quantity, title: li.title });
        this._deadletter({
          order_id: oid, name, email_hash: emailHash(email),
          sku: sku || null, qty: li.quantity, title: li.title,
          reason: sku ? "SKU not found in Axis (default_code)" : "line has no SKU",
        });
        continue;
      }
      lineRows.push([
        XID_LINE(oid, li.id),           // id (External ID)
        XID_ORDER(oid),                 // order_id/id
        prod.id,                        // product_id/.id
        `${li.title}${li.variant_title && li.variant_title !== "Default Title" ? " — " + li.variant_title : ""}`,
        li.quantity,
        li.price,
      ]);
    }

    const note = this.composeNote(order, deadLines);
    const dateOrder = toOdooDateTime(order.created_at);
    const origin = `Shopify order ${name}`;

    if (this.dryRun) {
      out.actions.push(`dry:upsert partner=${partner.id} lines=${lineRows.length} dead=${deadLines.length}`);
      out.final_state = order.cancelled_at ? "cancel" : CAPTURED.has(order.financial_status) ? "sale" : "draft";
      out.synced = true;
      return out;
    }

    // --- order upsert (load(): update-in-place via ir.model.data, never duplicates) ---
    const res = await this.axis.executeKw("sale.order", "load", [
      ["id", "partner_id/.id", "date_order", "client_order_ref", "origin"],
      [[XID_ORDER(oid), partner.id, dateOrder, name, origin]],
    ]);
    const errs = (res.messages || []).filter((m) => m.type === "error");
    if (errs.length) throw new Error(`sale.order load failed for ${name}: ${errs[0].message}`);
    const orderDbId = res.ids[0];
    out.axis_id = orderDbId;

    // --- line upserts (batched per order) ---
    if (lineRows.length) {
      const lres = await this.axis.executeKw("sale.order.line", "load", [
        ["id", "order_id/id", "product_id/.id", "name", "product_uom_qty", "price_unit"],
        lineRows,
      ]);
      const lerrs = (lres.messages || []).filter((m) => m.type === "error");
      if (lerrs.length) throw new Error(`sale.order.line load failed for ${name}: ${lerrs[0].message}`);
    }
    out.actions.push(`upserted lines=${lineRows.length}`);
    out.synced = true;

    // --- tag + deterministic note (same-value rewrite each cycle = idempotent) ---
    const tagId = await this.ensureTag();
    await this.axis.write("sale.order", [orderDbId], { tag_ids: [[4, tagId]], note });

    // --- stale line cleanup (order edited on Shopify after first sync) ---
    const imd = await this.axis.searchRead(
      "ir.model.data",
      [["model", "=", "sale.order.line"], ["name", "=like", `pes_line_${oid}_%`]],
      ["name", "res_id"]
    );
    const keep = new Set(lineRows.map((r) => r[0]));
    const stale = imd.filter((r) => !keep.has(r.name));
    if (stale.length) {
      const cur = await this.axis.read("sale.order", [orderDbId], ["state"]);
      if (cur[0].state === "draft") {
        await this.axis.unlink("sale.order.line", stale.map((s) => s.res_id));
        await this.axis.unlink("ir.model.data", stale.map((s) => s.id));
        out.actions.push(`removed stale lines=${stale.length}`);
      } else {
        this._deadletter({ order_id: oid, name, reason: `stale synced lines on non-draft order (state=${cur[0].state})`, stale_xids: stale.map((s) => s.name) });
      }
    }

    // --- state machine (never auto-confirm uncaptured) ---
    const curRows = await this.axis.read("sale.order", [orderDbId], ["state"]);
    const state = curRows[0].state;
    if (order.cancelled_at) {
      if (state !== "cancel") {
        try {
          await this.axis.executeKw("sale.order", "action_cancel", [[orderDbId]]);
          out.actions.push(`cancel (${state}->cancel)`);
        } catch (e) {
          this._deadletter({ order_id: oid, name, reason: `action_cancel failed from state=${state}: ${String(e.message).slice(0, 160)}` });
        }
      }
    } else if (CAPTURED.has(order.financial_status)) {
      if (state === "draft" || state === "sent") {
        await this.axis.executeKw("sale.order", "action_confirm", [[orderDbId]]);
        out.actions.push(`confirm (${state}->sale)`);
      }
    }
    out.final_state = order.cancelled_at ? "cancel" : CAPTURED.has(order.financial_status) ? "sale" : "draft";
    return out;
  }

  /** One sync cycle. dryRunOverride wins over the env default. */
  async runOnce({ dryRun } = {}) {
    if (this.running) return { already_running: true };
    const wasDry = this.dryRun;
    if (typeof dryRun === "boolean") this.dryRun = dryRun;
    this.running = true;
    const started = new Date();
    const stats = {
      started_at: started.toISOString(), dry_run: this.dryRun,
      checkpoint_from: this.readCheckpoint(), orders_seen: 0,
      upserted: 0, confirmed: 0, cancelled: 0, drafts: 0, deadletters: 0, errors: [],
    };
    try {
      if (!this.configured()) throw new Error("Shopify credentials not configured (SHOPIFY_CLIENT_ID + SHOPIFY_APP_SECRET)");
      const orders = await this.shopify.fetchOrdersSince(stats.checkpoint_from);
      stats.orders_seen = orders.length;
      console.log(`[order-sync] cycle start ${started.toISOString()} since=${stats.checkpoint_from} orders=${orders.length} dry=${this.dryRun}`);

      if (orders.length) {
        const partners = await this.resolvePartners(orders);
        const products = await this.resolveProducts(orders);
        for (const order of orders) {
          try {
            const out = await this.syncOrder(order, partners, products);
            if (out.synced) stats.upserted++;
            if (out.final_state === "sale") stats.confirmed++;
            else if (out.final_state === "cancel") stats.cancelled++;
            else if (out.final_state === "draft") stats.drafts++;
          } catch (e) {
            stats.errors.push({ order_id: order.id, name: order.name, error: String(e.message).slice(0, 200) });
            console.error(`[order-sync] order ${order.name} failed:`, e.message);
          }
        }
        // Checkpoint advances only on a fully clean cycle; any error replays
        // that window next time (safe — the path is idempotent).
        if (!stats.errors.length) {
          const maxUpdated = orders.reduce((m, o) => (o.updated_at > m ? o.updated_at : m), orders[0].updated_at);
          stats.checkpoint_to = maxUpdated;
          if (!this.dryRun) this.writeCheckpoint(maxUpdated);
        }
      } else {
        stats.checkpoint_to = stats.checkpoint_from;
      }
      stats.deadletters = this.deadletters.length;
    } catch (e) {
      stats.errors.push({ cycle_error: String(e.message).slice(0, 300) });
      console.error("[order-sync] cycle failed:", e.message);
    } finally {
      stats.finished_at = new Date().toISOString();
      this.lastRun = stats;
      this.running = false;
      this.dryRun = wasDry;
      console.log(`[order-sync] cycle done:`, JSON.stringify({ ...stats, errors: stats.errors.slice(0, 5) }));
    }
    return stats;
  }

  status() {
    return {
      enabled: !!this.timer,
      configured: this.configured(),
      dry_run: this.dryRun,
      running: this.running,
      checkpoint: this.readCheckpoint(),
      interval_min: parseInt(process.env.ORDER_SYNC_INTERVAL_MIN || "15", 10),
      last_run: this.lastRun,
      deadletters: this.deadletters.slice(-50),
    };
  }

  startLoop() {
    const minutes = parseInt(process.env.ORDER_SYNC_INTERVAL_MIN || "15", 10);
    // first run shortly after boot (SKU map seed is independent), then steady interval
    this.timer = setInterval(() => { this.runOnce().catch((e) => console.error("[order-sync] loop error:", e.message)); }, minutes * 60 * 1000);
    this.timer.unref();
    setTimeout(() => { this.runOnce().catch((e) => console.error("[order-sync] initial run error:", e.message)); }, 30000).unref();
    console.log(`[order-sync] loop enabled: every ${minutes} min (first run in 30s)`);
  }
}

module.exports = { OrderSyncService };
