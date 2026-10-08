"use strict";
/*
 * test-graph-mail.js — unit tests for the Graph mail rail wiring.
 * NO network, NO Graph credentials: sender is faked via _senderForTest.
 * Run: node scripts/test-graph-mail.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createGraphSender, buildMessage } = require("../graph-mail");
const { Mailer } = require("../mailer");

let passed = 0;
function ok(name) { passed++; console.log("PASS ", name); }

/* ---- buildMessage shape ---- */
const msg = buildMessage({
  to: "client@example.com",
  subject: "Quote S03001",
  html: "<b>hi</b>",
  text: "hi",
  fromAddress: "sales@portlandiaelectric.supply",
});
assert.strictEqual(msg.message.from.emailAddress.address, "sales@portlandiaelectric.supply");
assert.strictEqual(msg.message.sender.emailAddress.address, "sales@portlandiaelectric.supply");
assert.strictEqual(msg.message.body.contentType, "HTML"); // html preferred
assert.strictEqual(msg.message.body.content, "<b>hi</b>");
assert.deepStrictEqual(msg.message.toRecipients, [{ emailAddress: { address: "client@example.com" } }]);
assert.strictEqual(msg.saveToSentItems, true);
ok("buildMessage: from/sender alias, HTML body preferred, recipient shape");

const txtOnly = buildMessage({ to: ["a@x.co", "b@x.co"], subject: "s", text: "plain", fromAddress: "f@x.co" });
assert.strictEqual(txtOnly.message.body.contentType, "Text");
assert.strictEqual(txtOnly.message.toRecipients.length, 2);
ok("buildMessage: text fallback + multi-recipient");

/* ---- createGraphSender env gating (no network) ---- */
assert.strictEqual(createGraphSender({}), null);
assert.strictEqual(createGraphSender({ GRAPH_TENANT_ID: "t" }), null);
assert.strictEqual(createGraphSender({ GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c" }), null);
const gs = createGraphSender({ GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c", GRAPH_CLIENT_SECRET: "s" });
assert(gs && gs.name === "graph");
assert.strictEqual(gs.mailbox, "pes.sales@bsdyno.com");
assert.strictEqual(gs.fromAddress, "sales@portlandiaelectric.supply");
ok("createGraphSender: null without complete env; defaults for mailbox/from");

/* ---- Mailer: stub without any rail (env must be clean for this test) ---- */
delete process.env.GRAPH_TENANT_ID;
delete process.env.GRAPH_CLIENT_ID;
delete process.env.GRAPH_CLIENT_SECRET;
const stub = new Mailer({});
assert.strictEqual(stub.railStatus(), "stubbed-no-rail");
ok("mailer: stubbed when no rail configured");

/* ---- Mailer with fake Graph sender ---- */
const OUTBOX = path.join(__dirname, "..", "data", "email-outbox.json");
const backup = fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8") : null;
(async () => {
  try {
    const sentCalls = [];
    const fake = {
      name: "graph",
      mailbox: "pes.sales@bsdyno.com",
      fromAddress: "sales@portlandiaelectric.supply",
      send: async (m) => { sentCalls.push(m); },
    };
    const m = new Mailer({ _senderForTest: fake, _noAutoDrain: true });
    assert.strictEqual(m.railStatus(), "graph");
    ok("mailer: railStatus graph with sender present");

    const q = { id: 1, quote_no: "S03999", name: "T", total: 10, expiry: "2026-10-15", lines: [] };
    const res = await m.queue("created", { email: "owner@example.com", quote: q });
    assert.strictEqual(res.status, "sent");
    assert.strictEqual(sentCalls.length, 1);
    assert.strictEqual(sentCalls[0].to, "owner@example.com");
    assert(sentCalls[0].subject.includes("S03999"));
    assert(sentCalls[0].html.includes("S03999"));
    ok("mailer: queue() delivers through the graph sender (html+subject)");

    /* ---- drain: stubbed rows get sent, failed rows kept ---- */
    fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
    fs.writeFileSync(OUTBOX, JSON.stringify([
      { ts: "2026-10-07T00:00:00Z", event: "created", to: "old@example.com", subject: "old 1", status: "stubbed-no-rail", html: "<p>a</p>", text: "a" },
      { ts: "2026-10-07T00:01:00Z", event: "shared", to: "old2@example.com", subject: "old 2", status: "send-error", error: "boom", html: "<p>b</p>", text: "b" },
      { ts: "2026-10-07T00:02:00Z", event: "converted", to: "done@example.com", subject: "already", status: "sent", html: "<p>c</p>", text: "c" },
      { ts: "2026-10-07T00:03:00Z", event: "expiring", to: null, subject: "broken", status: "stubbed-no-rail" }, // unsendable: kept
    ]));
    const m2 = new Mailer({ _senderForTest: fake, _noAutoDrain: true });
    const summary = await m2.drainOutbox();
    assert.strictEqual(summary.pending, 2); // 2 sendable pending (null-to row excluded)
    assert.strictEqual(summary.sent, 2);
    const rows = JSON.parse(fs.readFileSync(OUTBOX, "utf8"));
    assert.strictEqual(rows.length, 4); // NOTHING dropped
    assert.strictEqual(rows[0].status, "sent");
    assert(rows[0].drained_at);
    assert.strictEqual(rows[1].status, "sent");
    assert.strictEqual(rows[2].status, "sent"); // untouched
    assert.strictEqual(rows[3].status, "stubbed-no-rail"); // unsendable row preserved
    ok("drainOutbox: stubbed/send-error re-sent, sent rows untouched, nothing dropped");

    // failing sender keeps rows with drain_error
    const failFake = { name: "graph", mailbox: "m", fromAddress: "f", send: async () => { throw new Error("Graph sendMail HTTP 403"); } };
    fs.writeFileSync(OUTBOX, JSON.stringify([
      { ts: "t", event: "created", to: "x@example.com", subject: "s", status: "stubbed-no-rail", html: "h", text: "t" },
    ]));
    const m3 = new Mailer({ _senderForTest: failFake, _noAutoDrain: true });
    const s3 = await m3.drainOutbox();
    assert.strictEqual(s3.kept, 1);
    const kept = JSON.parse(fs.readFileSync(OUTBOX, "utf8"));
    assert.strictEqual(kept[0].status, "stubbed-no-rail");
    assert(kept[0].drain_error.includes("403"));
    ok("drainOutbox: failed send keeps row + drain_error (never drops)");

    console.log(`\nALL GRAPH-MAIL TESTS PASSED (${passed})`);
  } finally {
    // restore the real outbox byte-for-byte
    if (backup !== null) fs.writeFileSync(OUTBOX, backup);
    else fs.rmSync(OUTBOX, { force: true });
  }
  process.exit(0);
})().catch((e) => {
  if (backup !== null) fs.writeFileSync(OUTBOX, backup);
  console.error("FAIL:", e.message);
  process.exit(1);
});
