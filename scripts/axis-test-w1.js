"use strict";
/*
 * axis-test-w1.js — Wave-1 validation against REAL Axis, through the running
 * local HTTP proxy (same discipline as axis-test-p1.js):
 *
 *   sku-search typeahead -> bulk preview (zero writes) -> bulk commit
 *   (3 lines, failures listed) -> idempotent re-commit (update-in-place)
 *   -> Make a Copy (new quote #, fresh validity, lines + notes carry,
 *   idempotent reuse) -> preview-as-client token (masked view, share links
 *   NOT invalidated, separate store) -> delete both quotes -> verify gone
 *   -> direct-Axis cleanup + store sweep.
 *
 * Writes are bounded to: one test partner, two test quotes
 * (ZZ-W1-DELETE-ME and its copy), line mutations on them, proxy-side
 * share/preview tokens, and one direct `note` write on the source quote to
 * prove notes carry. Everything is deleted and verified gone at the end.
 *
 * Usage (from order-status-app/web/):  node scripts/axis-test-w1.js
 * Requires: az CLI authenticated (or ODOO_API_KEY env var). Never prints secrets.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { loadConfig } = require("../config");
const { AxisClient } = require("../axis");

const PORT = 8793;
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = "zz-test-quote-partner@pes-test.invalid";
const TEST_PARTNER_NAME = "ZZ Test Quote Partner";
const TEST_QUOTE_NAME = "ZZ-W1-DELETE-ME";
const SKU_A = "USS-MIDN-LBBC"; // $0.25 — cheap
const SKU_B = "USS-MIDN-MNTBB2";
const SKU_C = "USS-MIDN-MNEDC";
const SKU_BAD = "ZZ-NOPE-404";
const NOTE_TEXT = "ZZ-W1 note: deliver to job site gate B";

let failures = 0;
function check(label, cond, extra = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
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

function assertNoPriceKeys(obj, where) {
  const walk = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (/price|total|savings|cost|amount/i.test(k)) throw new Error(`leaky key "${k}" in ${where}`);
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(obj);
}

async function main() {
  const env = { ...process.env, PORT: String(PORT) };
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env, stdio: ["ignore", "inherit", "inherit"],
  });

  let orderId = null;
  let copyId = null;
  try {
    await waitForServer(server);

    console.log("\n--- 0. create source quote ---");
    const c = await api("POST", "/proxy/quotes", {
      email: TEST_EMAIL, display_name: TEST_PARTNER_NAME, name: TEST_QUOTE_NAME,
      line: { sku: SKU_A, qty: 1 },
    });
    check("create 200", c.status === 200, JSON.stringify(c.json).slice(0, 140));
    orderId = c.json.quote && c.json.quote.id;
    check("quote id captured", !!orderId, "id=" + orderId);

    // Direct-Axis note write on the source quote (bounded, deleted with it):
    // proves Make a Copy carries notes (Lowe's silently drops them).
    {
      const cfg0 = loadConfig();
      const axis0 = new AxisClient(cfg0.odoo);
      await axis0.authenticate();
      await axis0.write("sale.order", [orderId], { note: NOTE_TEXT });
    }

    console.log("\n--- 1. sku-search typeahead ---");
    const s1 = await api("GET", `/proxy/quotes/sku-search?q=${encodeURIComponent("midn-lbbc")}`);
    check("sku-search 200 + finds test SKU by substring", s1.status === 200 && (s1.json.results || []).some((r) => r.sku === SKU_A),
      JSON.stringify((s1.json.results || [])[0] || {}).slice(0, 120));
    const s2 = await api("GET", `/proxy/quotes/sku-search?q=${encodeURIComponent("uss-midn-m")}`);
    const names = (s2.json.results || []).map((r) => r.sku);
    check("prefix results rank first", names.length > 0 && names[0].startsWith("USS-MIDN-M"), names.slice(0, 4).join(","));
    const s3 = await api("GET", `/proxy/quotes/sku-search?q=x`);
    check("<2 chars returns empty", s3.status === 200 && (s3.json.results || []).length === 0);

    console.log("\n--- 2. bulk preview (zero writes) ---");
    const PASTE = `${SKU_B}, 2\n${SKU_C}\t3\n${SKU_BAD}, 1\nBROKEN LINE, abc`;
    const pv = await api("POST", `/proxy/quotes/${orderId}/lines/bulk`, { email: TEST_EMAIL, text: PASTE, confirm: false });
    check("preview 200", pv.status === 200, JSON.stringify(pv.json).slice(0, 140));
    check("preview resolved 2", pv.json.resolved_count === 2, "got " + pv.json.resolved_count);
    check("preview resolved rows carry title", pv.json.resolved.every((r) => r.title), "");
    check("preview failed 2 with reasons (bad SKU + bad qty)",
      pv.json.failed_count === 2 && pv.json.failed.every((f) => f.reason),
      JSON.stringify(pv.json.failed).slice(0, 200));
    const dAfterPreview = await api("GET", `/proxy/quotes/${orderId}?email=${encodeURIComponent(TEST_EMAIL)}`);
    check("preview made ZERO writes (still 1 line)", dAfterPreview.json.lines.length === 1);

    console.log("\n--- 3. bulk commit (one call, failures listed) ---");
    const cm = await api("POST", `/proxy/quotes/${orderId}/lines/bulk`, { email: TEST_EMAIL, text: PASTE, confirm: true });
    check("commit 200", cm.status === 200, JSON.stringify(cm.json).slice(0, 140));
    check("2 added", cm.json.added_count === 2, "added=" + cm.json.added_count);
    check("2 failed loud (never silently dropped)", cm.json.failed_count === 2, JSON.stringify(cm.json.failed).slice(0, 200));
    check("quote now has 3 lines", cm.json.quote.lines.length === 3, "lines=" + cm.json.quote.lines.length);
    const skusOnQuote = cm.json.quote.lines.map((l) => l.sku).sort();
    check("lines carry SKUs A,B,C", JSON.stringify(skusOnQuote) === JSON.stringify([SKU_A, SKU_B, SKU_C].sort()), skusOnQuote.join(","));

    console.log("\n--- 4. bulk idempotency: re-commit updates in place, never duplicates ---");
    const cm2 = await api("POST", `/proxy/quotes/${orderId}/lines/bulk`, { email: TEST_EMAIL, text: PASTE, confirm: true });
    check("re-commit 200", cm2.status === 200);
    check("0 added on re-run", cm2.json.added_count === 0, "added=" + cm2.json.added_count);
    check("2 updated in place", cm2.json.updated_count === 2, "updated=" + cm2.json.updated_count);
    check("still exactly 3 lines (no duplicates)", cm2.json.quote.lines.length === 3, "lines=" + cm2.json.quote.lines.length);

    console.log("\n--- 5. Make a Copy ---");
    const cp = await api("POST", `/proxy/quotes/${orderId}/copy`, { email: TEST_EMAIL });
    check("copy 200", cp.status === 200, JSON.stringify(cp.json).slice(0, 160));
    copyId = cp.json.quote && cp.json.quote.id;
    check("new quote id != source", !!copyId && copyId !== orderId, "copy id=" + copyId);
    check("new quote # issued (different S number)", cp.json.quote.quote_no !== cp.json.copied_from,
      cp.json.copied_from + " -> " + cp.json.quote.quote_no);
    check('name carried as "<name> (Copy)"', cp.json.quote.name === `${TEST_QUOTE_NAME} (Copy)`, cp.json.quote.name);
    check("all 3 lines carried", cp.json.quote.lines.length === 3, "lines=" + cp.json.quote.lines.length);
    check("quantities carried", (() => {
      const q = Object.fromEntries(cp.json.quote.lines.map((l) => [l.sku, l.qty]));
      return q[SKU_A] === 1 && q[SKU_B] === 2 && q[SKU_C] === 3;
    })());
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    check("fresh 7-day validity", cp.json.quote.expiry === in7, "expiry=" + cp.json.quote.expiry);
    {
      // notes carried — verified via direct Axis read of the copy
      const cfgN = loadConfig();
      const axisN = new AxisClient(cfgN.odoo);
      await axisN.authenticate();
      const rows = await axisN.read("sale.order", [copyId], ["note"]);
      const noteVal = String(rows[0] && rows[0].note || "").replace(/<[^>]*>/g, "").trim();
      check("notes carried (Lowe's drops these; we don't)", noteVal.includes("ZZ-W1 note"), JSON.stringify(noteVal).slice(0, 80));
    }
    const cp2 = await api("POST", `/proxy/quotes/${orderId}/copy`, { email: TEST_EMAIL });
    check("copy is idempotent (reused draft copy)", cp2.status === 200 && cp2.json.reused === true && cp2.json.quote.id === copyId);

    console.log("\n--- 6. preview-as-client token flow ---");
    // A REAL share link created BEFORE the preview must survive preview creation.
    const realShare = await api("POST", `/proxy/quotes/${orderId}/share`, { email: TEST_EMAIL, mode: "full" });
    check("real share link created", realShare.status === 200 && !!realShare.json.token);
    const pvT = await api("POST", `/proxy/quotes/${orderId}/preview`, { email: TEST_EMAIL, mode: "none", note: "preview note" });
    check("preview token created", pvT.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(pvT.json.token || ""), "ttl=" + pvT.json.ttl_minutes);
    check("TTL is 15 minutes", pvT.json.ttl_minutes === 15);
    check("preview token != share token", pvT.json.token !== realShare.json.token);
    const pvView = await api("GET", `/proxy/quotes/shared/${pvT.json.token}`);
    check("preview view loads (no auth)", pvView.status === 200);
    check("preview flagged in payload", pvView.json.preview === true && !!pvView.json.preview_expires_at);
    try {
      assertNoPriceKeys(pvView.json, "preview mode=none payload");
      check("preview mode none leaks zero price fields", true);
    } catch (e) {
      check("preview mode none leaks zero price fields", false, e.message);
    }
    const stillReal = await api("GET", `/proxy/quotes/shared/${realShare.json.token}`);
    check("real share link NOT invalidated by preview", stillReal.status === 200 && stillReal.json.preview === false);
    const pvFull = await api("POST", `/proxy/quotes/${orderId}/preview`, { email: TEST_EMAIL, mode: "full" });
    const stillReal2 = await api("GET", `/proxy/quotes/shared/${realShare.json.token}`);
    check("second preview also leaves share link live", stillReal2.status === 200);
    const pvFullView = await api("GET", `/proxy/quotes/shared/${pvFull.json.token}`);
    check("preview full mode shows quoted prices", pvFullView.status === 200 && pvFullView.json.lines[0].unit_price >= 0 && "total" in pvFullView.json);

    console.log("\n--- 7. delete both quotes, verify gone ---");
    const d1 = await api("POST", `/proxy/quotes/${copyId}/delete`, { email: TEST_EMAIL, confirm: true });
    check("copy deleted", d1.status === 200 && d1.json.deleted === true);
    const d2 = await api("POST", `/proxy/quotes/${orderId}/delete`, { email: TEST_EMAIL, confirm: true });
    check("source deleted", d2.status === 200 && d2.json.deleted === true);
    const list = await api("GET", `/proxy/quotes?email=${encodeURIComponent(TEST_EMAIL)}`);
    check("list empty", (list.json.quotes || []).length === 0);
    check("source detail 404", (await api("GET", `/proxy/quotes/${orderId}?email=${encodeURIComponent(TEST_EMAIL)}`)).status === 404);
    check("copy detail 404", (await api("GET", `/proxy/quotes/${copyId}?email=${encodeURIComponent(TEST_EMAIL)}`)).status === 404);
    check("share token 404 (purged with quote)", (await api("GET", `/proxy/quotes/shared/${realShare.json.token}`)).status === 404);
    check("preview token 404 (purged with quote)", (await api("GET", `/proxy/quotes/shared/${pvT.json.token}`)).status === 404);
  } finally {
    server.kill();
  }

  // --- 8. direct Axis verification + cleanup ---
  console.log("\n--- 8. direct Axis verify + cleanup ---");
  const cfg = loadConfig();
  const axis = new AxisClient(cfg.odoo);
  await axis.authenticate();

  for (const [label, oid] of [["source", orderId], ["copy", copyId]]) {
    if (!oid) { check(`${label} quote absent from Axis`, false, "no id captured"); continue; }
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
    const goneP = await axis.search("res.partner", [["id", "=", partnerId]]);
    check("res.partner deleted from Axis", goneP.length === 0);
  } else {
    check("res.partner already absent", true);
  }

  // token stores: no rows may reference the deleted orders
  const dataDir = path.join(__dirname, "..", "data");
  for (const f of ["share-tokens.json", "preview-tokens.json"]) {
    const p = path.join(dataDir, f);
    const store = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    const leak = Object.values(store).some((r) => r.order_id === orderId || r.order_id === copyId);
    check(`${f}: no rows reference deleted orders`, !leak);
  }

  console.log(`\n${failures === 0 ? "ALL W1 CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("W1 test cycle error:", e);
  process.exit(1);
});
