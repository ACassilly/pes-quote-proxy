"use strict";
/*
 * test-w2b-units.js — Wave-2B unit tests, NO Axis calls, no writes anywhere
 * outside OS temp dirs.
 *
 * OWNER RULING 2026-10-08: flag-not-block. This suite pins:
 *   - flag threshold boundaries + disabled flagging
 *   - flag state model ({required, flagged, flagged_at}) — NO blocking state
 *     exists anywhere; conversion is never gated
 *   - flagForReview idempotency (one notification fan-out per episode),
 *     purgeOrder lifecycle
 *   - quote_flagged staff email composer (notification wording, NO approve
 *     link/token anywhere, banned-word scan)
 *   - Intercom flag-note composer + stub rail status
 *   - flagQueryString permalink cart attributes (exact shape, encoded quote #)
 *   - alias CRUD + normalization + reverse map + validation
 *   - alias resolution ORDER in bulk (customer alias beats catalog SKU;
 *     via_alias/customer_sku carried through resolveBulk)
 *   - maskQuote customer_sku passthrough (mode none pins minimal shape)
 *   - PDF renders "Your part #" when aliases exist
 *
 * Usage: node scripts/test-w2b-units.js   (exits non-zero on any failure)
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Redirect file-backed stores to a temp dir (same discipline as test-w1-units.js).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pesq-w2b-"));
for (const m of ["approval.js", "aliases.js", "share.js"]) {
  fs.copyFileSync(require.resolve("../" + m), path.join(tmpDir, m));
}
const approval = require(path.join(tmpDir, "approval.js"));
const aliases = require(path.join(tmpDir, "aliases.js"));
const share = require(path.join(tmpDir, "share.js"));
const bulk = require("../bulk.js");
const { compose } = require("../mailer.js");
const { composeFlagNote } = require("../intercom.js");
const { flagQueryString } = require("../quotes.js");
const pdf = require("../pdf.js");

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log("PASS  " + label);
  } catch (e) {
    failures++;
    console.log("FAIL  " + label + "  — " + e.message);
  }
}

const MIN = 10000;

/* ---------------- flag threshold ---------------- */

check("flag threshold: boundary is inclusive; <= 0 disables flagging", () => {
  assert.strictEqual(approval.needsApproval(9999.99, MIN), false);
  assert.strictEqual(approval.needsApproval(10000, MIN), true);
  assert.strictEqual(approval.needsApproval(10000.01, MIN), true);
  assert.strictEqual(approval.needsApproval(5, 0), false);
  assert.strictEqual(approval.needsApproval(5, -1), false);
  assert.strictEqual(approval.needsApproval(NaN, MIN), false);
});

/* ---------------- flag state model (no blocking state exists) ---------------- */

check("infoFor: over-threshold + empty store => required:true, flagged:false (never a block)", () => {
  const info = approval.infoFor(9001, 15000, MIN);
  assert.strictEqual(info.required, true);
  assert.strictEqual(info.flagged, false);
  assert.strictEqual(info.flagged_at, null);
  // No blocking vocabulary may exist in the state model:
  assert.ok(!("state" in info) && !JSON.stringify(info).includes("pending"), "no pending/blocked state allowed");
});

check("infoFor: under-threshold => required:false", () => {
  const info = approval.infoFor(9002, 500, MIN);
  assert.strictEqual(info.required, false);
  assert.strictEqual(info.flagged, false);
});

check("flagForReview: records flag, idempotent (one fan-out per episode), no tokens issued", () => {
  const a = approval.flagForReview(9100, 12345);
  assert.strictEqual(a.created, true);
  assert.strictEqual(a.flagged, true);
  assert.ok(!("token" in a), "approve-token machinery must be gone");
  const b = approval.flagForReview(9100, 12345);
  assert.strictEqual(b.created, false);
  const info = approval.infoFor(9100, 12345, MIN);
  assert.strictEqual(info.flagged, true);
  assert.ok(info.flagged_at);
  const raw = fs.readFileSync(approval.STORE_PATH, "utf8");
  assert.ok(!/token|hash/i.test(raw), "store must contain no token machinery");
});

check("purgeOrder drops flag state for the order only", () => {
  approval.flagForReview(9105, 11000);
  approval.flagForReview(9106, 11000);
  approval.purgeOrder(9105);
  assert.strictEqual(approval.infoFor(9105, 11000, MIN).flagged, false);
  assert.strictEqual(approval.infoFor(9106, 11000, MIN).flagged, true);
});

/* ---------------- permalink cart attributes (sales-channel flag) ---------------- */

check("flagQueryString: exact attribute shape, quote # encoded", () => {
  assert.strictEqual(
    flagQueryString("S03199"),
    "?attributes[pes-flag]=quote-review-needed&attributes[pes-quote-no]=S03199"
  );
  assert.ok(flagQueryString("S 1/2").includes("attributes[pes-quote-no]=S%201%2F2"));
});

/* ---------------- staff notification email (notification, not action) ---------------- */

check("quote_flagged email: notification wording, NO approve link/token, banned-word clean", () => {
  const msg = compose("quote_flagged", {
    email: "sales@portlandiaelectric.supply",
    customerEmail: "contractor@example.com",
    threshold: 10000,
    quote: {
      id: 123, quote_no: "S09999", name: "Substation Job", total: 15250.5,
      expiry: "2026-10-14", lines: [{ title: "A" }, { title: "B" }],
    },
    storefrontUrl: "https://www.portlandiaelectric.supply",
  });
  assert.match(msg.subject, /^Flagged for review:/);
  assert.match(msg.subject, /S09999/);
  assert.match(msg.subject, /\$15,250\.50/);
  assert.ok(msg.html.includes("contractor@example.com"));
  assert.match(msg.html, /NOT blocked/);
  assert.ok(!/approve\?token|Approve this quote|Single-use/i.test(msg.html + msg.subject + msg.text),
    "no approve-link language may survive");
  const banned = /supplier|vendor|dropship|drop-ship|backorder/i;
  assert.ok(!banned.test(msg.subject) && !banned.test(msg.html) && !banned.test(msg.text));
});

check("compose() rejects the retired approval_required event", () => {
  assert.throws(() => compose("approval_required", { quote: {} }), /unknown email event/);
});

/* ---------------- Intercom composer ---------------- */

check("intercom flag note: staff wording, NOT blocked, quote + customer + threshold", () => {
  const msg = composeFlagNote({
    quote: { quote_no: "S09999", name: "Substation Job", total: 15250.5, expiry: "2026-10-14", lines: [{}] },
    customerEmail: "contractor@example.com",
    threshold: 10000,
    flaggedAt: "2026-10-08T12:00:00.000Z",
  });
  assert.match(msg.subject, /S09999/);
  assert.match(msg.subject, /\$15,250\.50/);
  assert.ok(msg.body.includes("contractor@example.com"));
  assert.ok(msg.body.includes("2026-10-08T12:00:00.000Z"));
  assert.match(msg.body, /NOT blocked/);
  const banned = /supplier|vendor|dropship|drop-ship|backorder/i;
  assert.ok(!banned.test(msg.subject) && !banned.test(msg.body) && !banned.test(msg.text));
});

/* ---------------- alias CRUD + resolution ---------------- */

check("addAlias normalizes + lists + resolves; overwrite updates", () => {
  const a = aliases.addAlias("Contractor@Example.com", "acme-123", "USS-MIDN-LBBC");
  assert.strictEqual(a.customer_sku, "ACME-123");
  assert.strictEqual(aliases.resolve("contractor@example.com", "ACME-123"), "USS-MIDN-LBBC");
  assert.strictEqual(aliases.resolve("contractor@example.com", "acme-123"), "USS-MIDN-LBBC");
  aliases.addAlias("contractor@example.com", "ACME-123", "USS-MIDN-MNTBB2");
  assert.strictEqual(aliases.resolve("contractor@example.com", "ACME-123"), "USS-MIDN-MNTBB2");
  const list = aliases.listForEmail("contractor@example.com");
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].our_sku, "USS-MIDN-MNTBB2");
});

check("alias validation: empty / over-long rejected; unknown resolves null", () => {
  assert.throws(() => aliases.addAlias("a@b.co", "", "X"), (e) => e.status === 400);
  assert.throws(() => aliases.addAlias("a@b.co", "Y".repeat(65), "X"), (e) => e.status === 400);
  assert.throws(() => aliases.addAlias("a@b.co", "Y", ""), (e) => e.status === 400);
  assert.strictEqual(aliases.resolve("nobody@example.com", "ACME-123"), null);
});

check("aliases are per-customer (no cross-email leakage)", () => {
  aliases.addAlias("one@example.com", "PN-1", "SKU-A");
  assert.strictEqual(aliases.resolve("two@example.com", "PN-1"), null);
});

check("reverseMapForEmail: our_sku -> customer_sku, first alias wins", () => {
  aliases.addAlias("rev@example.com", "CUST-9", "OUR-9");
  aliases.addAlias("rev@example.com", "CUST-9B", "OUR-9");
  const rev = aliases.reverseMapForEmail("rev@example.com");
  assert.strictEqual(rev["OUR-9"], "CUST-9");
});

check("removeAlias removes only that row", () => {
  aliases.addAlias("del@example.com", "P-1", "S-1");
  aliases.addAlias("del@example.com", "P-2", "S-2");
  assert.strictEqual(aliases.removeAlias("del@example.com", "P-1"), true);
  assert.strictEqual(aliases.removeAlias("del@example.com", "P-1"), false);
  assert.strictEqual(aliases.listForEmail("del@example.com").length, 1);
});

/* ---------------- alias resolution ORDER in bulk ---------------- */

check("bulk alias resolution: customer alias beats catalog SKU; via_alias carried through resolveBulk", () => {
  const aliasMap = { "ACME-123": "USS-MIDN-LBBC", "REAL-1": "USS-MIDN-MNTBB2" };
  const parsed = bulk.parseBulkLines("ACME-123, 2\nREAL-1, 1\nZZ-NOPE-404, 1");
  for (const l of parsed.ok) {
    const hit = aliasMap[l.sku.toUpperCase()];
    if (hit) { l.customer_sku = l.sku; l.sku = hit; l.via_alias = true; }
  }
  const catalog = {
    "USS-MIDN-LBBC": { title: "Busbar Covers", shopify_price: 0.25, freight: false },
    "REAL-1": { title: "Catalog Item Real One", shopify_price: 9, freight: false },
    "USS-MIDN-MNTBB2": { title: "Mount", shopify_price: 5, freight: false },
  };
  const r = bulk.resolveBulk(parsed, (sku) => catalog[sku] || null);
  assert.strictEqual(r.resolved.length, 2);
  assert.strictEqual(r.resolved[0].sku, "USS-MIDN-LBBC");
  assert.strictEqual(r.resolved[0].customer_sku, "ACME-123");
  assert.strictEqual(r.resolved[0].via_alias, true);
  assert.strictEqual(r.resolved[1].sku, "USS-MIDN-MNTBB2"); // alias won over the colliding catalog SKU
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].sku, "ZZ-NOPE-404");
});

/* ---------------- order-sync carries the flag into the Axis note ---------------- */

check("order-sync composeNote carries pes-flag note_attributes into the Axis order note", () => {
  const { OrderSyncService } = require("../order-sync.js");
  const svc = new OrderSyncService(null, { shopify: { shopDomain: "x.myshopify.com" } });
  const order = {
    financial_status: "authorized", total_price: "10424.00", currency: "USD", total_tax: "0.00",
    note_attributes: [
      { name: "pes-flag", value: "quote-review-needed" },
      { name: "pes-quote-no", value: "S09999" },
    ],
  };
  const note = svc.composeNote(order, []);
  assert.ok(note.includes("QUOTE REVIEW FLAG"), "flag line missing from Axis note");
  assert.ok(note.includes("S09999"), "quote number missing from flag line");
  assert.ok(note.includes("never blocked"), "flag line must record the no-block ruling");
  const plain = svc.composeNote({ financial_status: "authorized", total_price: "1.00", currency: "USD", total_tax: "0" }, []);
  assert.ok(!plain.includes("QUOTE REVIEW FLAG"), "unflagged orders must not carry the flag line");
});

/* ---------------- maskQuote + PDF with customer part numbers ---------------- */

check("maskQuote: customer_sku carried in full/price_only; mode none pins minimal shape", () => {
  const QUOTE = {
    quote_no: "S08888", name: "Alias Job", expiry: "2026-10-14",
    expires_in_days: 7, expired: false, total: 100,
    footer: "Prices held until 2026-10-14 on eligible items. Availability confirmed at order time.",
    lines: [{ title: "Widget", sku: "OUR-1", customer_sku: "ACME-123", qty: 2, unit_price: 50, line_total: 100, list_price: 60, savings_pct: 16.7 }],
  };
  for (const mode of ["full", "price_only"]) {
    const masked = share.maskQuote(QUOTE, mode);
    assert.strictEqual(masked.lines[0].customer_sku, "ACME-123");
  }
  const none = share.maskQuote(QUOTE, "none");
  assert.deepStrictEqual(Object.keys(none.lines[0]).sort(), ["qty", "sku", "title"]);
  const walk = (o) => {
    for (const [k, v] of Object.entries(o)) {
      assert.ok(!/price|total|savings|cost|amount/i.test(k), `leaky key: ${k}`);
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(none);
});

check("PDF renders the customer part number alongside our SKU", () => {
  const buf = pdf.renderQuotePdf({
    quote: {
      quote_no: "S08888", name: "Alias Job", created: "2026-10-07", expiry: "2026-10-14",
      total: 100, expired: false,
      footer: "Prices held until Oct 14, 2026 on eligible items. Availability confirmed at order time.",
      lines: [{ title: "Widget", sku: "OUR-1", customer_sku: "ACME-123", qty: 2, unit_price: 50, line_total: 100, list_price: 60, savings_pct: 16.7 }],
    },
    partner: { name: "Test", email: "t@example.com" },
    mode: "full",
  });
  const text = buf.toString("latin1");
  assert.ok(text.includes("Your part # ACME-123"), "customer part number missing from PDF");
  assert.ok(text.includes("SKU OUR-1"), "our SKU missing from PDF");
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL W2B UNIT TESTS PASSED" : failures + " TEST(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
