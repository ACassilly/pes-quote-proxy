"use strict";
/*
 * axis-test-w2a.js — Wave-2A validation against REAL Axis, through the running
 * local HTTP proxy (same discipline as axis-test-w1.js):
 *
 *   create quote (2 lines) -> convert (marks past-converted) -> reorder
 *   history finds it (search by job name) -> reorder => NEW quote at ORIGINAL
 *   prices (pin proven by a direct-Axis custom price on the source line)
 *   -> idempotent re-reorder -> Save-Cart-as-Quote (copy semantics:
 *   cart_unchanged, failures loud, client prices IGNORED — pricelist owns
 *   price) -> trust-path 400s/404s -> delete everything -> verify gone ->
 *   direct-Axis cleanup + store sweep.
 *
 * Writes are bounded to: one test partner, three test quotes
 * (ZZ-W2A-DELETE-ME …), line mutations on them, one direct price_unit write on
 * the source line (proves the reorder pin), and proxy-side registry rows.
 * Everything is deleted and verified gone at the end.
 *
 * The cart-fallback (prices-updated) path requires an item that vanished from
 * the catalog — not simulable without mutating real products; covered by
 * scripts/test-w2a-units.js (planReorderLines/buildCartPermalink).
 *
 * Usage (from order-status-app/web/):  node scripts/axis-test-w2a.js
 * Requires: az CLI authenticated (or ODOO_API_KEY env var). Never prints secrets.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { loadConfig } = require("../config");
const { AxisClient } = require("../axis");

const PORT = 8794;
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = "zz-test-quote-partner@pes-test.invalid";
const TEST_PARTNER_NAME = "ZZ Test Quote Partner";
const QUOTE_NAME = "ZZ-W2A-DELETE-ME Fence Job";
const CART_QUOTE_NAME = "ZZ-W2A-DELETE-ME Cart Quote";
const SKU_A = "USS-MIDN-LBBC"; // $0.25 list — cheap
const SKU_B = "USS-MIDN-MNTBB2";
const SKU_BAD = "ZZ-NOPE-404";
const PIN_PRICE = 0.37; // custom source-line price — proves the reorder pin (list is 0.25)

// The local server runs WITH SHOPIFY_APP_SECRET set (so the reorder history
// can mint its client_credentials token), which also enables proxy HMAC —
// so this harness self-signs every request, the exact production path.
const CREDS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "shopify-admin-token.json"), "utf8")
);
const SECRET = CREDS.client_secret;

function signParams(params) {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  return crypto.createHmac("sha256", SECRET).update(message).digest("hex");
}

let failures = 0;
function check(label, cond, extra = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

async function api(method, p, body) {
  const [pathPart, existingQuery] = p.split("?");
  const q = Object.fromEntries(new URLSearchParams(existingQuery || "").entries());
  q.shop = "portlandiaelectricsupply.myshopify.com";
  q.timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signParams(q);
  const url = BASE + pathPart + "?" + new URLSearchParams({ ...q, signature }).toString();
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function waitForServer(child) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/healthz");
      if (r.ok) return;
    } catch {}
    if (child.exitCode !== null) throw new Error("server exited early: " + child.exitCode);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not come up in 30s");
}

async function main() {
  // The server runs with the real app credentials: SHOPIFY_APP_SECRET turns on
  // proxy HMAC (the harness signs, above) and doubles as the client_credentials
  // secret for the Shopify order-history path — identical to production.
  const env = {
    ...process.env,
    PORT: String(PORT),
    SHOPIFY_CLIENT_ID: CREDS.client_id,
    SHOPIFY_APP_SECRET: CREDS.client_secret,
    EXPIRY_SWEEP_ENABLED: "0", // don't email-sweep during the test
  };
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env, stdio: ["ignore", "inherit", "inherit"],
  });

  let sourceId = null;
  let reorderId = null;
  let cartQuoteId = null;
  const cfg = loadConfig();
  const axis = new AxisClient(cfg.odoo);

  try {
    await waitForServer(server);
    await axis.authenticate();

    console.log("\n--- 1. create source quote (2 lines) + pin a custom price ---");
    const c = await api("POST", "/proxy/quotes", {
      email: TEST_EMAIL, display_name: TEST_PARTNER_NAME, name: QUOTE_NAME,
      line: { sku: SKU_A, qty: 2 },
    });
    check("create 200", c.status === 200, JSON.stringify(c.json).slice(0, 140));
    sourceId = c.json.quote && c.json.quote.id;
    check("quote id captured", !!sourceId, "id=" + sourceId);
    if (!sourceId) throw new Error("create failed — aborting before any Axis writes");
    const addB = await api("POST", `/proxy/quotes/${sourceId}/lines`, {
      email: TEST_EMAIL, action: "add", sku: SKU_B, qty: 3,
    });
    check("second line added", addB.status === 200 && addB.json.lines.length === 2);

    // Direct-Axis bounded write: pin SKU_A line to a CUSTOM price (0.37 vs the
    // 0.25 pricelist price). If reorder carries 0.37, the honored-pricing pin
    // is proven — a pricelist recompute would produce 0.25.
    const srcLines = await axis.read("sale.order", [sourceId], ["order_line"]);
    const lineRows = await axis.read("sale.order.line", srcLines[0].order_line, ["id", "product_id", "price_unit"]);
    const prodA = await axis.searchRead("product.product", [["default_code", "=", SKU_A]], ["id"], { limit: 1 });
    const lineA = lineRows.find((l) => l.product_id && l.product_id[0] === prodA[0].id);
    await axis.write("sale.order.line", [lineA.id], { price_unit: PIN_PRICE });
    const detail1 = await api("GET", `/proxy/quotes/${sourceId}?email=${encodeURIComponent(TEST_EMAIL)}`);
    const pinnedLine = detail1.json.lines.find((l) => l.sku === SKU_A);
    check("source line pinned at custom price", Math.abs(pinnedLine.unit_price - PIN_PRICE) < 1e-9,
      "unit_price=" + pinnedLine.unit_price);

    console.log("\n--- 2. convert (marks the quote as past-converted) ---");
    const conv = await api("POST", `/proxy/quotes/${sourceId}/convert`, { email: TEST_EMAIL });
    check("convert 200 with permalink", conv.status === 200 && /^\/cart\/\d+:\d+/.test(conv.json.permalink || ""),
      (conv.json.permalink || "").slice(0, 60));

    console.log("\n--- 3. reorder history finds the converted quote ---");
    let hist = null;
    for (let i = 0; i < 20; i++) {
      hist = await api("GET", `/proxy/quotes/reorder/history?email=${encodeURIComponent(TEST_EMAIL)}&q=${encodeURIComponent("ZZ-W2A")}`);
      if (hist.status === 200 && (hist.json.results || []).some((r) => r.kind === "quote")) break;
      await new Promise((r) => setTimeout(r, 750)); // recordConversion is fire-and-forget
    }
    check("history 200", hist.status === 200, JSON.stringify(hist.json).slice(0, 160));
    const hit = (hist.json.results || []).find((r) => r.kind === "quote" && r.name === QUOTE_NAME);
    check("converted quote listed with job name", !!hit, JSON.stringify(hit || null));
    check("history sources block present", !!(hist.json.sources && hist.json.sources.converted_quotes === true));
    check("trust note present", /email/i.test(hist.json.trust_note || ""));
    const miss = await api("GET", `/proxy/quotes/reorder/history?email=${encodeURIComponent(TEST_EMAIL)}&q=zz-nomatch-xyz`);
    check("non-matching search returns empty", miss.status === 200 && miss.json.results.length === 0);
    check("history requires email", (await api("GET", `/proxy/quotes/reorder/history`)).status === 400);

    console.log("\n--- 4. reorder => NEW quote at ORIGINAL prices ---");
    const ro = await api("POST", `/proxy/quotes/reorder`, {
      email: TEST_EMAIL, source: { type: "quote", ref: sourceId },
    });
    check("reorder 200", ro.status === 200, JSON.stringify(ro.json).slice(0, 200));
    check("mode=quote (all items still exist)", ro.json.mode === "quote");
    check("honored_pricing true / prices_updated false",
      ro.json.honored_pricing === true && ro.json.prices_updated === false);
    const rq = ro.json.quote || {};
    reorderId = rq.id;
    check("reorder quote named '<job> (Reorder)'", rq.name === `${QUOTE_NAME} (Reorder)`, rq.name);
    check("new quote number differs", !!rq.quote_no && rq.quote_no !== detail1.json.quote_no,
      `${detail1.json.quote_no} -> ${rq.quote_no}`);
    check("line count carried", (rq.lines || []).length === 2);
    const rqLineA = (rq.lines || []).find((l) => l.sku === SKU_A);
    const rqLineB = (rq.lines || []).find((l) => l.sku === SKU_B);
    check("SKU_A honored at the PINNED custom price (price memory)",
      rqLineA && Math.abs(rqLineA.unit_price - PIN_PRICE) < 1e-9,
      "unit_price=" + (rqLineA && rqLineA.unit_price));
    check("quantities carried", rqLineA && rqLineA.qty === 2 && rqLineB && rqLineB.qty === 3);
    // Direct-Axis proof the pin is on the line itself (not a display artifact):
    const roLines = await axis.read("sale.order", [reorderId], ["order_line", "validity_date"]);
    const roLineRows = await axis.read("sale.order.line", roLines[0].order_line, ["id", "product_id", "price_unit", "product_uom_qty"]);
    const roLineA = roLineRows.find((l) => l.product_id && l.product_id[0] === prodA[0].id);
    check("Axis line carries pinned price_unit", Math.abs(roLineA.price_unit - PIN_PRICE) < 1e-9);
    check("fresh 7-day validity", /^\d{4}-\d{2}-\d{2}$/.test(roLines[0].validity_date || ""));

    console.log("\n--- 5. idempotent re-reorder (double-click safe) ---");
    const ro2 = await api("POST", `/proxy/quotes/reorder`, {
      email: TEST_EMAIL, source: { type: "quote", ref: sourceId },
    });
    check("re-reorder reuses the same draft quote", ro2.status === 200 && ro2.json.quote.id === reorderId
      && ro2.json.quote.reused === true);
    check("no duplicated lines", (ro2.json.quote.lines || []).length === 2);

    console.log("\n--- 6. Save Cart as Quote (copy semantics) ---");
    const sc = await api("POST", `/proxy/quotes/from-cart`, {
      email: TEST_EMAIL, name: CART_QUOTE_NAME,
      lines: [
        { sku: SKU_A, qty: 4, price: 0.01, unit_price: 0.01 }, // client price MUST be ignored
        { sku: SKU_B, qty: 1 },
        { sku: SKU_BAD, qty: 1 },
      ],
    });
    check("from-cart 200", sc.status === 200, JSON.stringify(sc.json).slice(0, 200));
    check("cart_unchanged true + explicit notice",
      sc.json.cart_unchanged === true && /unchanged/i.test(sc.json.notice || ""));
    check("2 added / 1 failed loud", sc.json.added_count === 2 && sc.json.failed_count === 1
      && sc.json.failed[0].sku === SKU_BAD && !!sc.json.failed[0].reason);
    cartQuoteId = sc.json.quote && sc.json.quote.id;
    check("cart quote has 2 lines", (sc.json.quote.lines || []).length === 2);
    const cqLineA = (sc.json.quote.lines || []).find((l) => l.sku === SKU_A);
    check("client price IGNORED (pricelist owns price)", cqLineA && Math.abs(cqLineA.unit_price - 0.01) > 1e-9,
      "unit_price=" + (cqLineA && cqLineA.unit_price));
    // Direct-Axis confirmation the 0.01 never landed:
    const cqLines = await axis.read("sale.order", [cartQuoteId], ["order_line"]);
    const cqLineRows = await axis.read("sale.order.line", cqLines[0].order_line, ["id", "product_id", "price_unit"]);
    const cqRowA = cqLineRows.find((l) => l.product_id && l.product_id[0] === prodA[0].id);
    check("Axis line priced by pricelist, not the client", Math.abs(cqRowA.price_unit - 0.01) > 1e-9,
      "price_unit=" + cqRowA.price_unit);
    const sc2 = await api("POST", `/proxy/quotes/from-cart`, {
      email: TEST_EMAIL, name: CART_QUOTE_NAME, lines: [{ sku: SKU_A, qty: 4 }, { sku: SKU_B, qty: 1 }],
    });
    check("re-save is idempotent (reuse, no dup lines)",
      sc2.status === 200 && sc2.json.reused === true && sc2.json.quote.id === cartQuoteId
      && (sc2.json.quote.lines || []).length === 2);
    check("from-cart requires a name",
      (await api("POST", `/proxy/quotes/from-cart`, { email: TEST_EMAIL, lines: [{ sku: SKU_A, qty: 1 }] })).status === 400);
    check("from-cart requires a valid email",
      (await api("POST", `/proxy/quotes/from-cart`, { email: "nope", name: "X", lines: [{ sku: SKU_A, qty: 1 }] })).status === 400);

    console.log("\n--- 7. trust path: reorder from unknown order/quote 404s ---");
    check("unknown quote ref 404",
      (await api("POST", `/proxy/quotes/reorder`, { email: TEST_EMAIL, source: { type: "quote", ref: "S999999" } })).status === 404);
    check("unknown order ref 404",
      (await api("POST", `/proxy/quotes/reorder`, { email: TEST_EMAIL, source: { type: "order", ref: "#ZZ000" } })).status === 404);
    check("reorder requires source",
      (await api("POST", `/proxy/quotes/reorder`, { email: TEST_EMAIL })).status === 400);

    console.log("\n--- 8. delete everything, verify gone ---");
    for (const [label, oid] of [["reorder", reorderId], ["cart-quote", cartQuoteId], ["source", sourceId]]) {
      const d = await api("POST", `/proxy/quotes/${oid}/delete`, { email: TEST_EMAIL, confirm: true });
      check(`${label} deleted`, d.status === 200 && d.json.deleted === true);
    }
    const list = await api("GET", `/proxy/quotes?email=${encodeURIComponent(TEST_EMAIL)}`);
    check("list empty", (list.json.quotes || []).length === 0);
    const histAfter = await api("GET", `/proxy/quotes/reorder/history?email=${encodeURIComponent(TEST_EMAIL)}&q=ZZ-W2A`);
    check("history no longer lists the deleted quote",
      !(histAfter.json.results || []).some((r) => r.kind === "quote"));
  } finally {
    server.kill();
  }

  console.log("\n--- 9. direct Axis verify + cleanup ---");
  for (const [label, oid] of [["source", sourceId], ["reorder", reorderId], ["cart-quote", cartQuoteId]]) {
    if (!oid) { check(`${label} absent from Axis`, false, "no id captured"); continue; }
    const gone = await axis.search("sale.order", [["id", "=", oid]]);
    check(`${label} sale.order absent from Axis`, gone.length === 0, "leftover=" + JSON.stringify(gone));
    if (gone.length) {
      try { await axis.unlink("sale.order", [oid]); } catch { await axis.write("sale.order", [oid], { state: "cancel" }); }
    }
  }
  const partnerId = (await axis.search("res.partner", [["email", "=ilike", TEST_EMAIL]], { limit: 1 }))[0] || null;
  if (partnerId) {
    const leftover = await axis.search("sale.order", [["partner_id", "=", partnerId]]);
    for (const oid of leftover) {
      try { await axis.unlink("sale.order", [oid]); } catch { await axis.write("sale.order", [oid], { state: "cancel" }); }
    }
    await axis.unlink("res.partner", [partnerId]);
    check("res.partner deleted from Axis",
      (await axis.search("res.partner", [["id", "=", partnerId]])).length === 0);
  } else {
    check("res.partner already absent", true);
  }

  // Proxy-side stores: no rows may reference the deleted orders.
  const dataDir = path.join(__dirname, "..", "data");
  const regPath = path.join(dataDir, "known-quotes.json");
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, "utf8")) : {};
  const regLeak = [sourceId, reorderId, cartQuoteId].some((id) => reg[String(id)]);
  check("registry: no rows reference deleted quotes", !regLeak);
  // Outbox sweep (mail rail stubbed; lifecycle rows for the test email are test residue).
  const outboxPath = path.join(dataDir, "email-outbox.json");
  if (fs.existsSync(outboxPath)) {
    const rows = JSON.parse(fs.readFileSync(outboxPath, "utf8"));
    if (Array.isArray(rows)) {
      const kept = rows.filter((r) => !JSON.stringify(r).includes(TEST_EMAIL));
      if (kept.length !== rows.length) fs.writeFileSync(outboxPath, JSON.stringify(kept, null, 2));
    }
  }

  console.log(`\n${failures === 0 ? "ALL W2A CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("W2A test cycle error:", e);
  process.exit(1);
});
