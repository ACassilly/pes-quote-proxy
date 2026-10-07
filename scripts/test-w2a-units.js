"use strict";
/*
 * test-w2a-units.js — Wave-2A unit tests, NO Axis calls, no writes anywhere.
 *
 * Covers:
 *   - reorder price logic: all-items-exist => quote mode with ORIGINAL unit
 *     prices carried (price memory); any missing item => cart mode; empty
 *     source => cart mode with nothing honored (service 400s before this)
 *   - cart permalink fallback: mapped lines land in /cart/{variant}:{qty},
 *     unmapped lines are listed loudly, never silently dropped
 *   - copy semantics (P2-5): client-supplied price fields are IGNORED when
 *     parsing cart lines (trust note) — only sku+qty survive; the cart-
 *     unchanged notice copy is present and explicit
 *   - alias trust path: identity is the normalized email (sameEmail); the
 *     history filter only surfaces records belonging to the exact identity;
 *     the email-shape rule matches the one the quotes list uses
 *   - reorderName shaping; historyMatches search semantics
 *
 * Usage: node scripts/test-w2a-units.js   (exits non-zero on any failure)
 */

const assert = require("assert");
const reorder = require("../reorder.js");
const bulk = require("../bulk.js");

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

/* ---------------- reorderName ---------------- */

check("reorderName appends the (Reorder) suffix", () => {
  assert.strictEqual(reorder.reorderName("Fence Job"), "Fence Job (Reorder)");
});

check("reorderName caps at 120 chars", () => {
  const n = reorder.reorderName("J".repeat(200));
  assert.ok(n.length <= 120);
  assert.ok(n.startsWith("JJJ"));
});

check("reorderName handles blank source names", () => {
  assert.strictEqual(reorder.reorderName(""), "Reorder (Reorder)");
  assert.strictEqual(reorder.reorderName(null), "Reorder (Reorder)");
});

/* ---------------- planReorderLines: the price logic ---------------- */

const ALL_EXIST = (l) => ({ product_id: 1000 + (l.product_id || 0), sku: l.sku || "SKU-X" });

check("all items exist => quote mode, ORIGINAL unit prices carried (price memory)", () => {
  const lines = [
    { product_id: 1, sku: "A-1", qty: 2, unit_price: 10.5, title: "Alpha" },
    { product_id: 2, sku: "B-2", qty: 5, unit_price: 99.99, title: "Beta" },
  ];
  const plan = reorder.planReorderLines(lines, ALL_EXIST);
  assert.strictEqual(plan.mode, "quote");
  assert.strictEqual(plan.missing.length, 0);
  assert.strictEqual(plan.honored.length, 2);
  assert.strictEqual(plan.honored[0].unit_price, 10.5);
  assert.strictEqual(plan.honored[1].unit_price, 99.99);
  assert.strictEqual(plan.honored[1].qty, 5);
});

check("any missing item => cart mode (never silently repriced into a quote)", () => {
  const lines = [
    { product_id: 1, sku: "A-1", qty: 2, unit_price: 10.5 },
    { product_id: 2, sku: "GONE", qty: 1, unit_price: 5 },
  ];
  const plan = reorder.planReorderLines(lines, (l) => (l.sku === "GONE" ? null : ALL_EXIST(l)));
  assert.strictEqual(plan.mode, "cart");
  assert.strictEqual(plan.honored.length, 1);
  assert.strictEqual(plan.missing.length, 1);
  assert.strictEqual(plan.missing[0].sku, "GONE");
  assert.ok(/no longer in the catalog/.test(plan.missing[0].reason));
});

check("all items missing => cart mode with zero honored", () => {
  const plan = reorder.planReorderLines([{ sku: "X", qty: 1, unit_price: 3 }], () => null);
  assert.strictEqual(plan.mode, "cart");
  assert.strictEqual(plan.honored.length, 0);
  assert.strictEqual(plan.missing.length, 1);
});

check("empty source => cart mode, nothing honored", () => {
  const plan = reorder.planReorderLines([], ALL_EXIST);
  assert.strictEqual(plan.mode, "cart");
  assert.strictEqual(plan.honored.length, 0);
});

/* ---------------- buildCartPermalink: current-price fallback ---------------- */

const STUB_MAP = {
  "A-1": { variant_id: 111, shopify_price: 12.0 },
  "B-2": { variant_id: 222, shopify_price: 105.0 },
};

check("permalink carries variant:qty for every mapped line", () => {
  const fb = reorder.buildCartPermalink(
    [
      { sku: "A-1", qty: 2 },
      { sku: "B-2", qty: 3 },
    ],
    (sku) => STUB_MAP[sku] || null
  );
  assert.strictEqual(fb.permalink, "/cart/111:2,222:3");
  assert.strictEqual(fb.items.length, 2);
  assert.strictEqual(fb.unmapped.length, 0);
});

check("unmapped lines fail LOUD (listed with reason, never dropped)", () => {
  const fb = reorder.buildCartPermalink(
    [
      { sku: "A-1", qty: 1 },
      { sku: "NOPE", qty: 4, title: "Ghost" },
      { sku: null, qty: 1, title: "No-sku line" },
    ],
    (sku) => STUB_MAP[sku] || null
  );
  assert.strictEqual(fb.permalink, "/cart/111:1");
  assert.strictEqual(fb.unmapped.length, 2);
  assert.strictEqual(fb.unmapped[0].sku, "NOPE");
  assert.ok(/not mapped/.test(fb.unmapped[0].reason));
  assert.ok(/no SKU/.test(fb.unmapped[1].reason));
});

check("nothing mappable => permalink is null (service turns this into a 400)", () => {
  const fb = reorder.buildCartPermalink([{ sku: "NOPE", qty: 1 }], () => null);
  assert.strictEqual(fb.permalink, null);
  assert.strictEqual(fb.items.length, 0);
});

/* ---------------- copy semantics (P2-5): client prices are ignored ---------------- */

check("cart-line parsing IGNORES any client-supplied price (trust note)", () => {
  const parsed = bulk.parseStructuredLines([
    { sku: "A-1", qty: 2, price: 0.01, unit_price: 0.01, line_total: 0.02 },
    { sku: "B-2", qty: 1, amount: -500 },
  ]);
  assert.strictEqual(parsed.failed.length, 0);
  assert.strictEqual(parsed.ok.length, 2);
  for (const l of parsed.ok) {
    const keys = Object.keys(l).sort();
    assert.deepStrictEqual(keys, ["line", "qty", "sku"]); // no price field survives
  }
});

check("cart-line parsing merges duplicate SKUs and caps qty sanity", () => {
  const parsed = bulk.parseStructuredLines([
    { sku: "A-1", qty: 2 },
    { sku: "a-1", qty: 3 },
    { sku: "BAD", qty: -1 },
    { sku: "" },
  ]);
  assert.strictEqual(parsed.ok.length, 1);
  assert.strictEqual(parsed.ok[0].qty, 5);
  assert.strictEqual(parsed.failed.length, 2);
});

check("cart-unchanged notice is explicit (copy, not move)", () => {
  assert.ok(/cart is unchanged/i.test(reorder.CART_UNCHANGED_NOTICE));
  assert.ok(/copied/i.test(reorder.CART_UNCHANGED_NOTICE));
});

check("prices-updated notice says prices are current", () => {
  assert.ok(/current prices/i.test(reorder.PRICES_UPDATED_NOTICE));
});

/* ---------------- alias trust path (email identity) ---------------- */

check("sameEmail normalizes case and whitespace", () => {
  assert.ok(reorder.sameEmail("  Contractor@PES.com ", "contractor@pes.com"));
  assert.ok(!reorder.sameEmail("a@b.com", "c@b.com"));
  assert.ok(!reorder.sameEmail(null, "c@b.com"));
});

check("history only surfaces records for the exact identity", () => {
  const rows = [
    { email: "pro@pes.com", converted_at: "2026-10-01T00:00:00Z", order_id: 1 },
    { email: "other@pes.com", converted_at: "2026-10-02T00:00:00Z", order_id: 2 },
    { email: "PRO@pes.com", converted_at: "2026-10-03T00:00:00Z", order_id: 3 },
    { email: "pro@pes.com", converted_at: null, order_id: 4 }, // never converted
  ];
  const mine = reorder.entriesForEmail(rows, "pro@pes.com");
  assert.deepStrictEqual(mine.map((r) => r.order_id), [3, 1]); // newest first, no #2/#4
});

check("email validation matches the quotes-list identity rule", () => {
  assert.ok(reorder.isValidEmail("guest@company.com"));
  assert.ok(!reorder.isValidEmail("not-an-email"));
  assert.ok(!reorder.isValidEmail("a@b"));
  assert.ok(!reorder.isValidEmail(""));
});

/* ---------------- historyMatches ---------------- */

check("historyMatches: empty query matches everything (initial load)", () => {
  assert.ok(reorder.historyMatches("", ["Fence Job", "S03174"]));
});

check("historyMatches: substring across name / quote # / order #", () => {
  assert.ok(reorder.historyMatches("fence", ["Fence Job", "S03174"]));
  assert.ok(reorder.historyMatches("s031", ["Fence Job", "S03174"]));
  assert.ok(reorder.historyMatches("#1510", ["Job", "#151081"]));
  assert.ok(!reorder.historyMatches("deck", ["Fence Job", "S03174"]));
});

/* ---------------- summary ---------------- */

if (failures) {
  console.log(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nALL W2A UNIT TESTS PASSED");
