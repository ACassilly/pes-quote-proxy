"use strict";
/*
 * axis-test-w2b.js — Wave-2B validation against REAL Axis, through the running
 * local HTTP proxy (same discipline as axis-test-w1.js):
 *
 *   gated quote -> convert => pending_approval (NO permalink) -> approval
 *   email composed to the STUBBED outbox (verify content, nothing sent)
 *   -> single-use approve token from the outbox link -> approve (HTML 200)
 *   -> token reuse rejected (409) -> convert returns permalink
 *   -> Axis flag (tag/note marker) set while pending, cleared after approval
 *   -> alias add -> bulk preview resolves via alias -> commit -> quote detail
 *   carries customer_sku -> PDF shows "Your part #" -> alias remove
 *   -> delete quote -> verify gone -> direct-Axis cleanup + store sweep.
 *
 * The approval gate is armed with QUOTE_APPROVAL_MIN=1 so the cheap test
 * quote crosses it. The approver email is a test mailbox; the mail rail is
 * stubbed so NOTHING is actually sent (outbox rows only).
 *
 * Usage (from order-status-app/web/):  node scripts/axis-test-w2b.js
 * Requires: az CLI authenticated (or ODOO_API_KEY env var). Never prints secrets.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { loadConfig } = require("../config");
const { AxisClient } = require("../axis");

const PORT = 8794;
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = "zz-test-quote-partner@pes-test.invalid";
const APPROVER_EMAIL = "zz-w2b-approver@pes-test.invalid";
const TEST_PARTNER_NAME = "ZZ Test Quote Partner";
const TEST_QUOTE_NAME = "ZZ-W2B-DELETE-ME";
const SKU_A = "USS-MIDN-LBBC"; // $0.25 — cheap
const SKU_B = "USS-MIDN-MNTBB2";
const CUST_SKU = "ACME-W2B-123";

let failures = 0;
function check(label, cond, extra = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

async function api(method, p, body, raw = false) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text() };
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

function readJson(rel, fallback) {
  const p = path.join(__dirname, "..", rel);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

async function main() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    QUOTE_APPROVAL_MIN: "1", // arm the gate for the cheap test quote
    QUOTE_APPROVER_EMAIL: APPROVER_EMAIL,
    EXPIRY_SWEEP_ENABLED: "0",
  };
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env, stdio: ["ignore", "inherit", "inherit"],
  });

  let orderId = null;
  try {
    await waitForServer(server);

    console.log("\n--- 1. create quote over the (test) threshold ---");
    const c = await api("POST", "/proxy/quotes", {
      email: TEST_EMAIL, display_name: TEST_PARTNER_NAME, name: TEST_QUOTE_NAME,
      line: { sku: SKU_A, qty: 4 },
    });
    check("create 200", c.status === 200, JSON.stringify(c.json).slice(0, 140));
    orderId = c.json.quote && c.json.quote.id;
    check("quote id captured", !!orderId, "id=" + orderId);
    check("total >= $1 test threshold", c.json.quote.total >= 1, "total=" + c.json.quote.total);
    check("detail approval block: required + PENDING (fail-closed, no record yet)",
      c.json.quote.approval && c.json.quote.approval.required === true && c.json.quote.approval.state === "pending",
      JSON.stringify(c.json.quote.approval));

    console.log("\n--- 2. convert => GATED pending_approval, no permalink ---");
    const cv1 = await api("POST", `/proxy/quotes/${orderId}/convert`, { email: TEST_EMAIL });
    check("convert 200 with pending_approval", cv1.status === 200 && cv1.json.pending_approval === true);
    check("NO permalink while gated", !cv1.json.permalink);
    check("pending payload carries threshold + message",
      cv1.json.threshold === 1 && /pending approval/i.test(cv1.json.message || ""), JSON.stringify(cv1.json).slice(0, 160));
    const cv2 = await api("POST", `/proxy/quotes/${orderId}/convert`, { email: TEST_EMAIL });
    check("second convert still pending (idempotent flag)", cv2.status === 200 && cv2.json.pending_approval === true);

    console.log("\n--- 3. approval email in the STUBBED outbox (composed, NOT sent) ---");
    const outbox = readJson("data/email-outbox.json", []);
    const approvalRows = outbox.filter((r) => r.event === "approval_required" && r.subject && r.subject.includes(c.json.quote.quote_no));
    check("exactly ONE approval_required row (deduped across both convert attempts)", approvalRows.length === 1, "rows=" + approvalRows.length);
    const row = approvalRows[0] || {};
    check("row addressed to the approver mailbox", row.to === APPROVER_EMAIL, "to=" + row.to);
    check("row status is stubbed-no-rail (NOTHING was sent)", row.status === "stubbed-no-rail", "status=" + row.status);
    check("row names the customer + total", row.html && row.html.includes(TEST_EMAIL) && /\$/.test(row.html));
    const m = row.html && row.html.match(/\/apps\/quotes\/approve\?token=([A-Za-z0-9_-]{43})/);
    check("approve link with 43-char single-use token present", !!m);
    const token = m && m[1];
    const banned = /supplier|vendor|dropship|drop-ship|backorder/i;
    check("no banned words in approval email", row.html && !banned.test(row.html) && !banned.test(row.subject));

    console.log("\n--- 4. Axis flag while pending (tag or note marker) ---");
    {
      const cfg0 = loadConfig();
      const axis0 = new AxisClient(cfg0.odoo);
      await axis0.authenticate();
      const rows = await axis0.read("sale.order", [orderId], ["tag_ids", "note"]);
      const tags = rows[0].tag_ids || [];
      let tagNames = [];
      if (tags.length) {
        const tr = await axis0.read("sale.order.tag", tags, ["name"]);
        tagNames = tr.map((t) => t.name);
      }
      const noteHasMarker = String(rows[0].note || "").includes("[PES-APPROVAL-PENDING]");
      check("Axis sale.order flagged pending (tag or note marker)",
        tagNames.includes("PES Approval Pending") || noteHasMarker, "tags=" + JSON.stringify(tagNames));
    }

    console.log("\n--- 5. approve via token (HTML), single-use enforced ---");
    const bad = await api("GET", "/proxy/quotes/approve?token=" + "z".repeat(43), null, true);
    check("unknown token => 404 HTML, state untouched", bad.status === 404 && /not accepted/i.test(bad.text));
    const ap1 = await api("GET", "/proxy/quotes/approve?token=" + token, null, true);
    check("approve 200 + confirmation page", ap1.status === 200 && /approved/i.test(ap1.text));
    const ap2 = await api("GET", "/proxy/quotes/approve?token=" + token, null, true);
    check("token reuse => 409 (single-use)", ap2.status === 409 && /already used/i.test(ap2.text));

    console.log("\n--- 6. convert now succeeds; Axis flag cleared ---");
    const det = await api("GET", `/proxy/quotes/${orderId}?email=${encodeURIComponent(TEST_EMAIL)}`);
    check("detail approval state now APPROVED", det.json.approval && det.json.approval.state === "approved");
    const cv3 = await api("POST", `/proxy/quotes/${orderId}/convert`, { email: TEST_EMAIL });
    check("convert returns permalink after approval", cv3.status === 200 && /^\/cart\//.test(cv3.json.permalink || ""), (cv3.json.permalink || "").slice(0, 60));
    check("convert response carries approved state", cv3.json.approval && cv3.json.approval.state === "approved");
    {
      const cfg0 = loadConfig();
      const axis0 = new AxisClient(cfg0.odoo);
      await axis0.authenticate();
      const rows = await axis0.read("sale.order", [orderId], ["tag_ids", "note"]);
      const tags = rows[0].tag_ids || [];
      let tagNames = [];
      if (tags.length) {
        const tr = await axis0.read("sale.order.tag", tags, ["name"]);
        tagNames = tr.map((t) => t.name);
      }
      const noteHasMarker = String(rows[0].note || "").includes("[PES-APPROVAL-PENDING]");
      check("Axis pending flag cleared after approval", !tagNames.includes("PES Approval Pending") && !noteHasMarker);
    }

    console.log("\n--- 7. aliases: add -> bulk via alias -> detail + PDF -> remove ---");
    const aBad = await api("POST", "/proxy/quotes/aliases", { email: TEST_EMAIL, customer_sku: "ACME-W2B-BAD", our_sku: "ZZ-NOPE-404" });
    check("alias to unknown SKU rejected (400)", aBad.status === 400);
    const a1 = await api("POST", "/proxy/quotes/aliases", { email: TEST_EMAIL, customer_sku: CUST_SKU, our_sku: SKU_B });
    check("alias saved", a1.status === 200 && a1.json.saved === true, JSON.stringify(a1.json).slice(0, 120));
    const aList = await api("GET", `/proxy/quotes/aliases?email=${encodeURIComponent(TEST_EMAIL)}`);
    check("alias listed", aList.status === 200 && (aList.json.aliases || []).some((a) => a.customer_sku === CUST_SKU && a.our_sku === SKU_B));

    const pv = await api("POST", `/proxy/quotes/${orderId}/lines/bulk`, { email: TEST_EMAIL, text: `${CUST_SKU}, 2\nZZ-NOPE-404, 1`, confirm: false });
    check("bulk preview resolves customer part number via alias",
      pv.status === 200 && pv.json.resolved_count === 1 && pv.json.resolved[0].via_alias === true &&
      pv.json.resolved[0].customer_sku === CUST_SKU && pv.json.resolved[0].sku === SKU_B,
      JSON.stringify(pv.json.resolved || []).slice(0, 200));
    check("failed line keeps the original token (for the save-as-alias UI)",
      pv.json.failed_count === 1 && pv.json.failed[0].sku === "ZZ-NOPE-404");
    const cm = await api("POST", `/proxy/quotes/${orderId}/lines/bulk`, { email: TEST_EMAIL, text: `${CUST_SKU}, 2`, confirm: true });
    check("commit via alias adds the mapped SKU",
      cm.status === 200 && cm.json.added_count === 1 && cm.json.added[0].sku === SKU_B && cm.json.added[0].customer_sku === CUST_SKU);
    const det2 = await api("GET", `/proxy/quotes/${orderId}?email=${encodeURIComponent(TEST_EMAIL)}`);
    const aliasLine = (det2.json.lines || []).find((l) => l.sku === SKU_B);
    check("quote detail line carries customer_sku", !!aliasLine && aliasLine.customer_sku === CUST_SKU, JSON.stringify(aliasLine || {}).slice(0, 160));
    const pdfRes = await fetch(`${BASE}/proxy/quotes/${orderId}/pdf?email=${encodeURIComponent(TEST_EMAIL)}&mode=full`);
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    check("PDF shows 'Your part # ACME-W2B-123'", pdfRes.status === 200 && pdfBuf.toString("latin1").includes(`Your part # ${CUST_SKU}`));
    const aDel = await api("POST", "/proxy/quotes/aliases/remove", { email: TEST_EMAIL, customer_sku: CUST_SKU });
    check("alias removed", aDel.status === 200 && aDel.json.removed === true);
    const pv2 = await api("POST", `/proxy/quotes/${orderId}/lines/bulk`, { email: TEST_EMAIL, text: `${CUST_SKU}, 1`, confirm: false });
    check("after removal the customer part number no longer resolves", pv2.json.resolved_count === 0 && pv2.json.failed_count === 1);

    console.log("\n--- 8. delete quote, verify gone + approval store purged ---");
    const d = await api("POST", `/proxy/quotes/${orderId}/delete`, { email: TEST_EMAIL, confirm: true });
    check("quote deleted", d.status === 200 && d.json.deleted === true);
    check("detail 404", (await api("GET", `/proxy/quotes/${orderId}?email=${encodeURIComponent(TEST_EMAIL)}`)).status === 404);
    const approvals = readJson("data/quote-approvals.json", { orders: {}, tokens: {} });
    const leak = (approvals.orders && approvals.orders[String(orderId)]) ||
      Object.values(approvals.tokens || {}).some((t) => t.order_id === orderId);
    check("approval store purged with the quote", !leak);
  } finally {
    server.kill();
  }

  // --- 9. direct Axis verify + cleanup ---
  console.log("\n--- 9. direct Axis verify + cleanup ---");
  const cfg = loadConfig();
  const axis = new AxisClient(cfg.odoo);
  await axis.authenticate();

  if (!orderId) {
    check("quote absent from Axis", false, "no id captured");
  } else {
    const gone = await axis.search("sale.order", [["id", "=", orderId]]);
    check("sale.order absent from Axis", gone.length === 0, "leftover=" + JSON.stringify(gone));
    if (gone.length) {
      try { await axis.unlink("sale.order", [orderId]); } catch { await axis.write("sale.order", [orderId], { state: "cancel" }); }
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

  // alias store: no rows may reference the test mailboxes
  const aliasStore = readJson("data/customer-aliases.json", {});
  check("alias store has no test-mailbox rows", !aliasStore[TEST_EMAIL] && !aliasStore[APPROVER_EMAIL]);

  console.log(`\n${failures === 0 ? "ALL W2B CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("W2B test cycle error:", e);
  process.exit(1);
});
