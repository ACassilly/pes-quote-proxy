"use strict";
/*
 * axis-test-w2b2.js — Wave-2B FLAG-NOT-BLOCK (owner ruling 2026-10-08) live
 * validation against REAL Axis, through the running local HTTP proxy:
 *
 *   over-threshold quote -> convert SUCCEEDS immediately (permalink, never
 *   gated) -> permalink carries pes-flag cart attributes -> flag store
 *   records flagged:true -> Axis crm.tag pes_flag_review + mail.activity on
 *   the sale.order -> outbox email composed with notification wording (NO
 *   approve link, stubbed rail, nothing sent) -> Intercom stub row composed
 *   -> re-convert dedupes fan-out -> /approve endpoint 410-Gone
 *   -> delete -> verify gone -> direct-Axis cleanup (order, activities,
 *   partner) + store sweep.
 *
 * The flag threshold is armed with QUOTE_FLAG_MIN=1 for the cheap test quote.
 * Intercom has NO token anywhere (KV inventory checked 2026-10-08), so the
 * rail composes to data/intercom-outbox.json with status stubbed-no-token.
 *
 * Usage (from order-status-app/web/):  node scripts/axis-test-w2b2.js
 * Requires: az CLI authenticated (or ODOO_API_KEY env var). Never prints secrets.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { loadConfig } = require("../config");
const { AxisClient } = require("../axis");

const PORT = 8795;
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = "zz-test-quote-partner@pes-test.invalid";
const STAFF_EMAIL = "zz-w2b-staff@pes-test.invalid";
const TEST_PARTNER_NAME = "ZZ Test Quote Partner";
const TEST_QUOTE_NAME = "ZZ-FLAG-DELETE-ME";
const SKU_A = "USS-MIDN-LBBC"; // $0.25 — cheap

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
    QUOTE_FLAG_MIN: "1", // arm the flag for the cheap test quote
    QUOTE_FLAG_EMAIL: STAFF_EMAIL,
    EXPIRY_SWEEP_ENABLED: "0",
  };
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env, stdio: ["ignore", "inherit", "inherit"],
  });

  let orderId = null;
  let quoteNo = null;
  try {
    await waitForServer(server);

    console.log("\n--- 1. create over-threshold (test-armed) quote ---");
    const c = await api("POST", "/proxy/quotes", {
      email: TEST_EMAIL, display_name: TEST_PARTNER_NAME, name: TEST_QUOTE_NAME,
      line: { sku: SKU_A, qty: 4 },
    });
    check("create 200", c.status === 200, JSON.stringify(c.json).slice(0, 140));
    orderId = c.json.quote && c.json.quote.id;
    quoteNo = c.json.quote && c.json.quote.quote_no;
    check("total >= $1 test threshold", c.json.quote.total >= 1, "total=" + c.json.quote.total);
    check("detail flag block: required, not yet flagged, NO pending state",
      c.json.quote.flag && c.json.quote.flag.required === true && c.json.quote.flag.flagged === false &&
      !("approval" in c.json.quote) && !("state" in c.json.quote.flag),
      JSON.stringify(c.json.quote.flag));

    console.log("\n--- 2. CONVERT SUCCEEDS (never gated), permalink carries attributes ---");
    const cv1 = await api("POST", `/proxy/quotes/${orderId}/convert`, { email: TEST_EMAIL });
    check("convert 200", cv1.status === 200, JSON.stringify(cv1.json).slice(0, 160));
    check("permalink returned immediately (NO pending_approval anywhere)",
      /^\/cart\//.test(cv1.json.permalink || "") && !("pending_approval" in cv1.json));
    check("permalink carries pes-flag + pes-quote-no cart attributes",
      (cv1.json.permalink || "").includes("attributes[pes-flag]=quote-review-needed") &&
      (cv1.json.permalink || "").includes(`attributes[pes-quote-no]=${quoteNo}`),
      cv1.json.permalink);
    check("response flag block: flagged:true with timestamp",
      cv1.json.flag && cv1.json.flag.flagged === true && !!cv1.json.flag.flagged_at);

    console.log("\n--- 3. staff email composed to STUBBED outbox (notification wording, no approve link) ---");
    await new Promise((r) => setTimeout(r, 500)); // fan-out is fire-and-forget
    const outbox = readJson("data/email-outbox.json", []);
    const flagRows = outbox.filter((r) => r.event === "quote_flagged" && r.subject && r.subject.includes(quoteNo));
    check("exactly ONE quote_flagged row", flagRows.length === 1, "rows=" + flagRows.length);
    const row = flagRows[0] || {};
    check("row addressed to staff mailbox", row.to === STAFF_EMAIL, "to=" + row.to);
    check("row status stubbed-no-rail (NOTHING sent)", row.status === "stubbed-no-rail");
    check("notification wording: flagged for review + NOT blocked", /^Flagged for review:/.test(row.subject || "") && /NOT blocked/.test(row.html || ""));
    check("NO approve link/token in the email", !/approve\?token|Single-use/i.test(row.html || ""));
    const banned = /supplier|vendor|dropship|drop-ship|backorder/i;
    check("banned-word scan clean", !banned.test(row.subject || "") && !banned.test(row.html || ""));

    console.log("\n--- 4. Intercom STUB row composed (no token anywhere) ---");
    const ibox = readJson("data/intercom-outbox.json", []);
    const irows = ibox.filter((r) => r.type === "quote-flag" && r.subject && r.subject.includes(quoteNo));
    check("exactly ONE intercom quote-flag row", irows.length === 1, "rows=" + irows.length);
    check("intercom row status stubbed-no-token", (irows[0] || {}).status === "stubbed-no-token");
    check("intercom note carries quote + customer + NOT-blocked", irows[0] && /NOT blocked/.test(irows[0].body || "") && (irows[0].body || "").includes(TEST_EMAIL));

    console.log("\n--- 5. Axis ERP flag: crm.tag pes_flag_review + mail.activity ---");
    {
      const cfg0 = loadConfig();
      const axis0 = new AxisClient(cfg0.odoo);
      await axis0.authenticate();
      const rows = await axis0.read("sale.order", [orderId], ["tag_ids", "note"]);
      const tagIds = rows[0].tag_ids || [];
      let tagNames = [];
      if (tagIds.length) tagNames = (await axis0.read("crm.tag", tagIds, ["name"])).map((t) => t.name);
      check("crm.tag pes_flag_review on the sale.order", tagNames.includes("pes_flag_review"), "tags=" + JSON.stringify(tagNames));
      const acts = await axis0.searchRead(
        "mail.activity",
        [["res_model", "=", "sale.order"], ["res_id", "=", orderId]],
        ["id", "summary", "note"],
        { limit: 5 }
      );
      check("mail.activity created on the quote", acts.length >= 1, "activities=" + acts.length);
      if (acts.length) {
        check("activity note records quote # + threshold + never-blocked",
          /flagged for staff attention/i.test(acts[0].summary || "") &&
          String(acts[0].note || "").includes(quoteNo) &&
          /NOT blocked/i.test(String(acts[0].note || "")));
      }
    }

    console.log("\n--- 6. re-convert: still succeeds, fan-out deduped ---");
    const cv2 = await api("POST", `/proxy/quotes/${orderId}/convert`, { email: TEST_EMAIL });
    check("second convert also returns permalink", cv2.status === 200 && /^\/cart\//.test(cv2.json.permalink || ""));
    await new Promise((r) => setTimeout(r, 500));
    const outbox2 = readJson("data/email-outbox.json", []);
    check("still exactly ONE quote_flagged email (deduped)",
      outbox2.filter((r) => r.event === "quote_flagged" && r.subject && r.subject.includes(quoteNo)).length === 1);
    const ibox2 = readJson("data/intercom-outbox.json", []);
    check("still exactly ONE intercom row (deduped)",
      ibox2.filter((r) => r.type === "quote-flag" && r.subject && r.subject.includes(quoteNo)).length === 1);

    console.log("\n--- 7. retired approve endpoint => 410 Gone, clear message ---");
    const ap = await api("GET", "/proxy/quotes/approve?token=" + "z".repeat(43), null, true);
    check("410 Gone", ap.status === 410, "status=" + ap.status);
    check("message: never blocked / no action needed", /never blocked/i.test(ap.text) && /no action is needed/i.test(ap.text));

    console.log("\n--- 8. delete quote, verify gone + flag store purged ---");
    const d = await api("POST", `/proxy/quotes/${orderId}/delete`, { email: TEST_EMAIL, confirm: true });
    check("quote deleted", d.status === 200 && d.json.deleted === true);
    check("detail 404", (await api("GET", `/proxy/quotes/${orderId}?email=${encodeURIComponent(TEST_EMAIL)}`)).status === 404);
    const flags = readJson("data/quote-approvals.json", { orders: {} });
    check("flag store purged with the quote", !(flags.orders && flags.orders[String(orderId)]));
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
    const orphanActs = await axis.search("mail.activity", [["res_model", "=", "sale.order"], ["res_id", "=", orderId]]);
    check("no orphan mail.activity rows for the deleted quote", orphanActs.length === 0, "leftover=" + JSON.stringify(orphanActs));
    for (const aid of orphanActs) { try { await axis.unlink("mail.activity", [aid]); } catch {} }
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

  console.log(`\n${failures === 0 ? "ALL W2B-FLAG CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("W2B-flag test cycle error:", e);
  process.exit(1);
});
