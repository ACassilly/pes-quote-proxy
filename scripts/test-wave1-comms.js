"use strict";
/*
 * test-wave1-comms.js — unit tests for the Wave-1 comms modules (no Axis):
 *  - pdf.js: full / price_only / none documents; none-mode leaks no prices;
 *    totals math (subtotal - savings = total); legal blocks present with OUR
 *    terms (7-day validity, availability-not-guaranteed, authorize-after-
 *    confirm, materials-only); Lowe's terms ABSENT (store-binding, change-
 *    cancels); PDF structure (%PDF header, xref, %%EOF, logo XObject).
 *  - mailer.js: 4 event composers; banned words (supplier/dropship/vendor/
 *    backorder) never appear; masking mode named in shared email; stubbed
 *    rail queues to outbox; dedupe suppresses repeat expiring sends.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const pdf = require("../pdf");
const { Mailer, compose } = require("../mailer");

const QUOTE = {
  id: 3051,
  name: "Fence Job",
  quote_no: "S03051",
  state: "draft",
  total: 230.08,
  untaxed: 230.08,
  expiry: "2026-10-14",
  expires_in_days: 7,
  expired: false,
  created: "2026-10-07 15:04:11",
  updated_at: "2026-10-07 15:04:11",
  lines: [
    { line_id: 1, sku: "USS-MIDN-LBBC", title: "Green Busbar Safety Covers", qty: 4, unit_price: 23.78, line_total: 95.12, list_price: 32.5, savings_pct: 26.8 },
    { line_id: 2, sku: "USS-ABC-2", title: "Widget Two With A Rather Long Product Title That Wraps Onto Multiple Lines In The PDF Table", qty: 2, unit_price: 67.48, line_total: 134.96, list_price: 67.48, savings_pct: null },
  ],
  footer: "Prices held until 2026-10-14 on eligible items. Availability confirmed at order time.",
};
const PARTNER = { name: "Michael Cassily", email: "mike@example.com", phone: "555-0100", address: "1041 Barrett Ave, Louisville, KY 40204, United States" };

let passed = 0;
function ok(name, cond) {
  assert(cond, name);
  passed++;
  console.log("PASS", name);
}

/* ---------- PDF ---------- */

for (const mode of ["full", "price_only", "none"]) {
  const buf = pdf.renderQuotePdf({ quote: QUOTE, partner: PARTNER, mode });
  const text = buf.toString("latin1");
  ok(`pdf ${mode}: header`, text.startsWith("%PDF-1.4"));
  ok(`pdf ${mode}: eof`, text.includes("%%EOF"));
  ok(`pdf ${mode}: xref`, text.includes("xref") && text.includes("trailer"));
  ok(`pdf ${mode}: logo embedded`, text.includes("/DCTDecode"));
  ok(`pdf ${mode}: quote no`, text.includes("S03051"));
  ok(`pdf ${mode}: validity terms`, text.includes("held until Oct 14, 2026"));
  ok(`pdf ${mode}: availability-not-guaranteed`, text.includes("Availability is not guaranteed"));
  ok(`pdf ${mode}: authorize-after-confirm`, text.includes("authorized but not") && text.includes("charged until we confirm"));
  ok(`pdf ${mode}: materials-only shield`, text.includes("supplying materials only") || text.includes("supply materials only"));
  ok(`pdf ${mode}: restate (D1)`, text.includes("restarts the 7-day price hold") && text.includes("quote number stays the same"));
  ok(`pdf ${mode}: freight separate`, text.includes("quoted separately"));
  ok(`pdf ${mode}: no Lowe's store-binding`, !text.includes("Store #"));
  ok(`pdf ${mode}: no change-cancels`, !text.includes("cancel this quote"));
  ok(`pdf ${mode}: no supplier language`, !/supplier|dropship|vendor/i.test(text));
  fs.writeFileSync(path.join(__dirname, `test-quote-${mode}.pdf`), buf);
}

{
  const full = pdf.renderQuotePdf({ quote: QUOTE, partner: PARTNER, mode: "full" }).toString("latin1");
  ok("pdf full: unit price shown", full.includes("23.78"));
  ok("pdf full: savings badge", full.includes("Save 26.8%"));
  ok("pdf full: savings line", full.includes("Estimated quote savings"));
  ok("pdf full: delivery-at-checkout", full.includes("Calculated at checkout"));
  ok("pdf full: partner name", full.includes("Michael Cassily"));
  ok("pdf full: job name", full.includes("Fence Job"));
  // subtotal 4*32.50 + 2*67.48 = 264.96; total = 95.12+134.96 = 230.08; savings = 34.88
  ok("pdf full: subtotal math", full.includes("$264.96"));
  ok("pdf full: savings math", full.includes("-$34.88"));
  ok("pdf full: total math", full.includes("$230.08"));
}
{
  const po = pdf.renderQuotePdf({ quote: QUOTE, partner: PARTNER, mode: "price_only" }).toString("latin1");
  ok("pdf price_only: retail unit shown", po.includes("$32.50"));
  ok("pdf price_only: no savings fields", !po.includes("Save ") && !po.includes("Estimated quote savings"));
}
{
  const none = pdf.renderQuotePdf({ quote: QUOTE, partner: PARTNER, mode: "none" }).toString("latin1");
  // Scan only text-draw operators (… ) Tj — the embedded JPEG stream can
  // contain arbitrary byte sequences that look like prices.
  const drawn = (none.match(/\((?:\\.|[^\\)])*\) Tj/g) || []).join("\n");
  ok("pdf none: NO dollar amounts", !drawn.includes("$"));
  ok("pdf none: no unit prices", !drawn.includes("23.78") && !drawn.includes("32.50") && !drawn.includes("1,608") && !drawn.includes("230.08"));
  ok("pdf none: titles still present", drawn.includes("Green Busbar Safety Covers"));
  ok("pdf none: qty still present", /\(4\) Tj/.test(drawn));
}
{
  // many lines => multi-page
  const many = { ...QUOTE, lines: Array.from({ length: 60 }, (_, i) => ({ ...QUOTE.lines[0], line_id: i, title: "Line item " + i })) };
  const buf = pdf.renderQuotePdf({ quote: many, partner: PARTNER, mode: "full" }).toString("latin1");
  const pageCount = (buf.match(/\/Type \/Page[^s]/g) || []).length;
  ok("pdf multi-page for 60 lines", pageCount >= 2);
}

/* ---------- Mailer ---------- */

const CTX = { email: "mike@example.com", quote: QUOTE, storefrontUrl: "https://www.portlandiaelectric.supply" };

for (const ev of ["created", "expiring", "converted"]) {
  const msg = compose(ev, { ...CTX, cartUrl: "https://www.portlandiaelectric.supply/cart/1:4" });
  ok(`mail ${ev}: subject`, typeof msg.subject === "string" && msg.subject.includes("S03051"));
  ok(`mail ${ev}: html shell`, msg.html.includes("PES Supply") && msg.html.includes("600px"));
  ok(`mail ${ev}: text part`, typeof msg.text === "string" && msg.text.length > 20);
  ok(`mail ${ev}: footer terms`, msg.html.includes("Availability confirmed at order time") || msg.html.includes("Availability is confirmed at order time"));
  ok(`mail ${ev}: no banned words`, !/supplier|dropship|vendor|backorder/i.test(msg.html + msg.subject + msg.text));
  ok(`mail ${ev}: sales@ identity`, msg.html.includes("sales@portlandiaelectric.supply"));
}
{
  const msg = compose("shared", { ...CTX, share: { mode: "none", share_path: "/pages/shared-quote?token=abc" } });
  ok("mail shared: masking mode named", msg.html.includes("No Price"));
  ok("mail shared: link included", msg.html.includes("/pages/shared-quote?token=abc"));
  ok("mail shared: revoke note", /revok/i.test(msg.html));
}
{
  const exp = compose("expiring", CTX);
  ok("mail expiring: 2 days left", exp.html.includes("2 days left") || exp.subject.includes("2 days"));
  ok("mail expiring: convert CTA", /convert/i.test(exp.html));
}

(async () => {
  const outbox = path.join(__dirname, "..", "data", "email-outbox.json");
  const backup = fs.existsSync(outbox) ? fs.readFileSync(outbox, "utf8") : null;
  try {
    const m = new Mailer({ resendApiKey: null, storefrontUrl: "https://www.portlandiaelectric.supply" });
    ok("mailer: rail stubbed without key", m.railStatus() === "stubbed-no-rail");
    const r1 = await m.queue("expiring", CTX, { dedupeKey: "test:expiring:1" });
    ok("mailer: stub queues", r1.status === "stubbed-no-rail");
    const r2 = await m.queue("expiring", CTX, { dedupeKey: "test:expiring:1" });
    ok("mailer: dedupe suppresses repeat", r2.status === "deduped");
    const rows = JSON.parse(fs.readFileSync(outbox, "utf8"));
    const mine = rows.filter((r) => r.dedupe_key === "test:expiring:1");
    ok("mailer: one outbox row for deduped sends", mine.length === 1 && mine[0].status === "stubbed-no-rail");
    ok("mailer: outbox row has full html", mine[0].html.includes("PES Supply"));
  } finally {
    if (backup !== null) fs.writeFileSync(outbox, backup);
  }
  console.log(`\n${passed} checks PASSED`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
