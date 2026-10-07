"use strict";
/*
 * test-w2b-units.js — Wave-2B unit tests, NO Axis calls, no writes anywhere
 * outside OS temp dirs.
 *
 * Covers:
 *   - approval threshold boundaries + disabled gate
 *   - FAIL-CLOSED approval state (unknown/empty store = pending, never convertible)
 *   - approve-token lifecycle (shape, hash-only storage, single-use, 72h expiry,
 *     unknown/missing, flagPending idempotency, purgeOrder)
 *   - approval_required email composer (subject/summary/approve URL, banned-word scan)
 *   - alias CRUD + normalization + reverse map + validation
 *   - alias resolution ORDER in bulk (customer alias beats catalog SKU;
 *     via_alias/customer_sku carried through resolveBulk)
 *   - maskQuote passes customer_sku through without leaking prices in mode none
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

/* ---------------- approval threshold ---------------- */

check("needsApproval: boundary is inclusive at the threshold", () => {
  assert.strictEqual(approval.needsApproval(9999.99, MIN), false);
  assert.strictEqual(approval.needsApproval(10000, MIN), true);
  assert.strictEqual(approval.needsApproval(10000.01, MIN), true);
});

check("needsApproval: threshold <= 0 disables the gate; NaN total never required", () => {
  assert.strictEqual(approval.needsApproval(5, 0), false);
  assert.strictEqual(approval.needsApproval(5, -1), false);
  assert.strictEqual(approval.needsApproval(NaN, MIN), false);
});

/* ---------------- fail-closed approval state ---------------- */

check("infoFor FAILS CLOSED: over-threshold + empty store => pending (not convertible)", () => {
  const info = approval.infoFor(9001, 15000, MIN);
  assert.strictEqual(info.required, true);
  assert.strictEqual(info.state, "pending");
  assert.strictEqual(info.flagged_at, null);
});

check("infoFor: under-threshold => required:false, state none", () => {
  const info = approval.infoFor(9002, 500, MIN);
  assert.strictEqual(info.required, false);
  assert.strictEqual(info.state, "none");
});

/* ---------------- approve-token lifecycle ---------------- */

check("flagPending: creates pending record + 43-char token + 72h expiry; store holds only the hash", () => {
  const f = approval.flagPending(9100, 12345);
  assert.strictEqual(f.created, true);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(f.token));
  assert.strictEqual(f.ttl_hours, 72);
  const raw = fs.readFileSync(approval.STORE_PATH, "utf8");
  assert.ok(!raw.includes(f.token), "raw token must never be stored");
  const info = approval.infoFor(9100, 12345, MIN);
  assert.strictEqual(info.state, "pending");
  assert.ok(info.flagged_at);
});

check("flagPending is idempotent: second call creates nothing new", () => {
  const a = approval.flagPending(9101, 11000);
  const b = approval.flagPending(9101, 11000);
  assert.strictEqual(a.created, true);
  assert.strictEqual(b.created, false);
  assert.strictEqual(b.token, undefined);
});

check("approveToken: success marks approved + convertible; second use => 409 (single-use)", () => {
  const f = approval.flagPending(9102, 11000);
  const out = approval.approveToken(f.token);
  assert.strictEqual(out.order_id, 9102);
  assert.strictEqual(approval.infoFor(9102, 11000, MIN).state, "approved");
  assert.throws(() => approval.approveToken(f.token), (e) => e.status === 409);
});

check("approveToken: expired token => 410 and state stays pending (fail closed)", () => {
  const f = approval.flagPending(9103, 11000);
  const future = Date.now() + 73 * 3600 * 1000; // beyond 72h TTL
  assert.throws(() => approval.approveToken(f.token, future), (e) => e.status === 410);
  assert.strictEqual(approval.infoFor(9103, 11000, MIN).state, "pending");
});

check("approveToken: unknown => 404, missing => 400, state never mutated", () => {
  assert.throws(() => approval.approveToken("x".repeat(43)), (e) => e.status === 404);
  assert.throws(() => approval.approveToken(undefined), (e) => e.status === 400);
});

check("approval on an already-approved order reports approved without a new token", () => {
  const f = approval.flagPending(9104, 11000);
  approval.approveToken(f.token);
  const again = approval.flagPending(9104, 11000);
  assert.strictEqual(again.state, "approved");
  assert.strictEqual(again.created, false);
});

check("purgeOrder drops approval + token rows for the order only", () => {
  const a = approval.flagPending(9105, 11000);
  const b = approval.flagPending(9106, 11000);
  approval.purgeOrder(9105);
  assert.strictEqual(approval.infoFor(9105, 11000, MIN).state, "pending"); // record gone => fail closed pending
  assert.throws(() => approval.approveToken(a.token), (e) => e.status === 404);
  assert.strictEqual(approval.infoFor(9106, 11000, MIN).flagged_at !== null, true);
  assert.ok(approval.approveToken(b.token)); // other order untouched
});

/* ---------------- approval email composer ---------------- */

check("approval_required email: subject + summary + approve URL, rail-compatible shape", () => {
  const msg = compose("approval_required", {
    email: "sales@portlandiaelectric.supply",
    customerEmail: "contractor@example.com",
    threshold: 10000,
    approveUrl: "https://www.portlandiaelectric.supply/apps/quotes/approve?token=TESTTOKEN",
    quote: {
      id: 123, quote_no: "S09999", name: "Substation Job", total: 15250.5,
      expiry: "2026-10-14", lines: [{ title: "A" }, { title: "B" }],
    },
    storefrontUrl: "https://www.portlandiaelectric.supply",
  });
  assert.match(msg.subject, /S09999/);
  assert.match(msg.subject, /\$15,250\.50/);
  assert.ok(msg.html.includes("token=TESTTOKEN"));
  assert.ok(msg.html.includes("contractor@example.com"));
  assert.ok(msg.html.includes("Single-use link"));
  assert.match(msg.text, /approve\?token=TESTTOKEN/);
  const banned = /supplier|vendor|dropship|drop-ship|backorder/i;
  assert.ok(!banned.test(msg.subject) && !banned.test(msg.html) && !banned.test(msg.text), "banned word in approval email");
});

/* ---------------- alias CRUD + resolution ---------------- */

check("addAlias normalizes + lists + resolves; overwrite updates", () => {
  const a = aliases.addAlias("Contractor@Example.com", "acme-123", "USS-MIDN-LBBC");
  assert.strictEqual(a.customer_sku, "ACME-123");
  assert.strictEqual(aliases.resolve("contractor@example.com", "ACME-123"), "USS-MIDN-LBBC");
  assert.strictEqual(aliases.resolve("contractor@example.com", "acme-123"), "USS-MIDN-LBBC"); // case-insensitive
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
  assert.strictEqual(rev["OUR-9"], "CUST-9"); // sorted keys => first wins
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
  // Simulate the quotes.js transform: alias map applied BEFORE resolveBulk.
  const aliasMap = { "ACME-123": "USS-MIDN-LBBC", "REAL-1": "USS-MIDN-MNTBB2" };
  // "REAL-1" also exists in the catalog — the alias must win for this customer.
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
  assert.strictEqual(r.resolved[0].title, "Busbar Covers");
  assert.strictEqual(r.resolved[1].sku, "USS-MIDN-MNTBB2"); // alias won over the colliding catalog SKU
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].sku, "ZZ-NOPE-404"); // original token preserved for the save-as-alias UI
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
  // mode=none lines are pinned to exactly {title, sku, qty} (masking invariant).
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
