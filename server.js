"use strict";
/*
 * server.js — PES quote proxy HTTP server (zero dependencies, Node >= 18).
 *
 * Routes mirror the Shopify app-proxy subpath /apps/quotes/* which Shopify
 * forwards to <application_url>/proxy/* once the app proxy is registered
 * (see web/README.md — registration is pending Partner credentials).
 *
 *   GET  /healthz
 *   POST /proxy/quotes                       {email, name, display_name?, customer_id?, line?{sku,qty}}
 *   GET  /proxy/quotes?email=…               list active quotes (drawer)
 *   GET  /proxy/quotes/:ref?email=…          quote detail (ref = Axis id, SQ number, or job name)
 *   POST /proxy/quotes/:ref/rename           {email, name}
 *   POST /proxy/quotes/:ref/lines            {email, action: add|update|remove, sku?, qty?, line_id?}
 *   POST /proxy/quotes/:ref/convert          {email} -> {permalink, drift, requires_review, …}
 *   POST /proxy/quotes/:ref/expire-refresh   {email}
 *   POST /proxy/quotes/:ref/delete           {email, confirm:true}  (P1 — cannot undo)
 *   POST /proxy/quotes/:ref/share            {email, mode: full|price_only|none, note?}  (P1)
 *   POST /proxy/quotes/:ref/share/revoke     {email, token?}  (P1 — revokes all when token omitted)
 *   GET  /proxy/quotes/shared/:token         token-gated masked view, NO email (P1);
 *                                            also resolves Wave-1 15-min preview tokens
 *   GET  /proxy/quotes/sku-search?q=…        Wave-1 — SKU/name typeahead (quick add)
 *   POST /proxy/quotes/:ref/lines/bulk       Wave-1 — {email, text|lines, confirm}
 *                                            preview (zero writes) or one idempotent batch commit
 *   POST /proxy/quotes/:ref/copy             Wave-1 — {email} -> new quote #, fresh
 *                                            7-day validity, lines + PO/Job + notes carry
 *   POST /proxy/quotes/:ref/preview          Wave-1 — {email, mode, note?} -> ephemeral
 *                                            15-min preview token (never touches share links)
 *   GET  /proxy/quotes/:ref/pdf?email=…      Wave-1 — PES-branded quote PDF (P2-3);
 *                                            optional ?mode=full|price_only|none
 *   GET  /proxy/quotes/shared/:token/pdf     Wave-1 — shared-link PDF, masked per the
 *                                            token's mode ("none" => zero prices/totals)
 *   POST /proxy/quotes/ops/sweep             Wave-1 — manual run of the day-5-of-7
 *                                            expiring-quote email sweep (also runs on a
 *                                            12h in-process interval; mail rail STUBBED
 *                                            unless RESEND_API_KEY is set — see mailer.js)
 *   GET  /proxy/quotes/reorder/history?email=…&q=…
 *                                            Wave-2A (P2-11) — past converted quotes +
 *                                            order history, searchable by quote name /
 *                                            PO / job name / order # (email-identity
 *                                            trust model, same as the quotes list)
 *   POST /proxy/quotes/reorder               Wave-2A (P2-11) — {email, source:{type:
 *                                            quote|order, ref}} -> new quote at ORIGINAL
 *                                            prices when every item still exists, else a
 *                                            current-price cart permalink with a visible
 *                                            "prices updated" notice
 *   POST /proxy/quotes/from-cart             Wave-2A (P2-5) — {email, name, lines:
 *                                            [{sku, qty}]} -> copy the cart into a new
 *                                            named draft quote; the cart is NEVER
 *                                            emptied; only sku+qty are accepted (client
 *                                            prices are ignored — Axis owns price)
 *   POST /proxy/quotes/:ref/convert          Wave-2A: a successful convert now also marks
 *                                            the quote as a past converted quote for the
 *                                            reorder surface (proxy registry)
 *
 * Auth model: app-proxy requests are verified with the Shopify proxy HMAC
 * signature when SHOPIFY_APP_SECRET is set. Without it (local dev) the server
 * logs a warning header and serves anyway — deploy MUST set the secret.
 */

const http = require("http");
const crypto = require("crypto");
const { loadConfig } = require("./config");
const { AxisClient } = require("./axis");
const { QuoteService, HttpError } = require("./quotes");
const { ReorderService } = require("./reorder");
const { OrderSyncService } = require("./order-sync");
const skuMap = require("./sku-map");

function verifyProxySignature(query, secret) {
  // Shopify app proxy signs sorted key=value pairs (minus `signature`) with HMAC-SHA256.
  const { signature, ...rest } = query;
  if (!signature) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const sigBuf = Buffer.from(String(signature));
  const digBuf = Buffer.from(digest);
  // timingSafeEqual throws on length mismatch — reject malformed lengths as 401.
  return sigBuf.length === digBuf.length && crypto.timingSafeEqual(digBuf, sigBuf);
}

// --- Per-IP token-bucket rate limiting (proxy routes only, /healthz exempt) ---
// capacity 60 = burst allowance; refill 1 token/sec = sustained 60 req/min.
// Note: storefront-proxied traffic arrives from Shopify egress IPs, so all
// shoppers sharing one Shopify egress IP share a bucket — 60/min sustained
// with a 60 burst is ample for drawer/detail quote traffic per egress IP.
const RATE_LIMIT = {
  capacity: parseInt(process.env.RATE_LIMIT_BURST || "60", 10),
  refillPerSec: parseFloat(process.env.RATE_LIMIT_PER_SEC || "1"), // 60/min sustained
  buckets: new Map(),
};

function clientIp(req) {
  // Caddy (the only reachable hop to this port) appends the true peer IP to
  // X-Forwarded-For; take the LAST entry so a spoofed client header cannot
  // steal another identity's bucket.
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const parts = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimitOk(ip) {
  const now = Date.now();
  let b = RATE_LIMIT.buckets.get(ip);
  if (!b) {
    b = { tokens: RATE_LIMIT.capacity, ts: now };
    RATE_LIMIT.buckets.set(ip, b);
  }
  b.tokens = Math.min(RATE_LIMIT.capacity, b.tokens + ((now - b.ts) / 1000) * RATE_LIMIT.refillPerSec);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Evict idle buckets every 5 min so the map cannot grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of RATE_LIMIT.buckets) if (v.ts < cutoff) RATE_LIMIT.buckets.delete(k);
}, 5 * 60 * 1000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendPdf(res, { buffer, filename }) {
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Length": buffer.length,
    "Content-Disposition": `attachment; filename="${String(filename).replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "Cache-Control": "no-store",
  });
  res.end(buffer);
}

// Wave-2B: approval confirmation page (clicked from the approver email).
function sendHtml(res, status, { title, message, ok }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — PES Supply</title></head>
<body style="margin:0;background:#f2f4f7;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:48px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;">
<tr><td style="padding:32px;">
<div style="font-size:22px;font-weight:800;color:#1d6b3f;margin-bottom:16px;">PES Supply</div>
<div style="font-size:24px;font-weight:800;color:${ok ? "#111111" : "#8a5a00"};line-height:1.25;">${esc(title)}</div>
<p style="font-size:15px;color:#444444;line-height:1.55;">${message}</p>
<p style="font-size:13px;color:#777777;">Questions? Write to <a href="mailto:sales@portlandiaelectric.supply" style="color:#1d6b3f;">sales@portlandiaelectric.supply</a>.</p>
</td></tr></table></td></tr></table></body></html>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function main() {
  const cfg = loadConfig();
  const axis = new AxisClient(cfg.odoo);
  const svc = new QuoteService(axis, cfg);
  const w2a = new ReorderService(svc, cfg); // Wave-2A: reorder + save-cart-as-quote
  const orderSync = new OrderSyncService(axis, cfg);

  if (!cfg.shopify.appSecret) {
    console.warn("[proxy] SHOPIFY_APP_SECRET not set — LOCAL DEV MODE, proxy signatures not verified");
  }
  if (/^(1|true|yes)$/i.test(process.env.ORDER_SYNC_ENABLED || "")) {
    orderSync.startLoop();
  }

  // Admin-token gate for ops routes (/admin/*). Disabled entirely (404) when
  // ORDER_SYNC_ADMIN_TOKEN is unset; comparison is length-checked + constant-time.
  const adminToken = process.env.ORDER_SYNC_ADMIN_TOKEN || null;
  function adminOk(req) {
    if (!adminToken) return false;
    const given = Buffer.from(String(req.headers["x-admin-token"] || ""));
    const want = Buffer.from(adminToken);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  // Wave-1: day-5-of-7 expiring-quote email sweep on a 12h in-process
  // interval (first run 10 min after boot, so it doesn't race the SKU-map
  // seed). Registry-guardrailed to proxy-touched quotes only; deduped per
  // (order, validity). With the mail rail stubbed this only writes outbox
  // rows — nothing is emailed until RESEND_API_KEY is set.
  if (!/^(0|false|no)$/i.test(process.env.EXPIRY_SWEEP_ENABLED || "")) {
    const runSweep = () => svc.sweepExpiringQuotes().catch((e) => console.warn("[sweep]", e.message));
    setTimeout(runSweep, 10 * 60 * 1000).unref();
    setInterval(runSweep, 12 * 60 * 60 * 1000).unref();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      const path = u.pathname.replace(/\/+$/, "") || "/";
      const query = Object.fromEntries(u.searchParams.entries());

      if (path === "/healthz" && req.method === "GET") {
        send(res, 200, {
          ok: true,
          sku_map: skuMap.stats(),
          dev_mode: !cfg.shopify.appSecret,
          mail_rail: svc.mailer.railStatus(), // "resend" or STUBBED "stubbed-no-rail"
          intercom_rail: svc.intercom.railStatus(), // "intercom" or STUBBED "stubbed-no-token"
          quote_flag_min: cfg.quoteFlagMin, // Wave-2B flag threshold (never blocks)
          order_sync: { configured: orderSync.configured(), loop_enabled: !!orderSync.timer },
        });
        return;
      }

      // Ops routes: admin-token gated, never Shopify-proxied. 404 when disabled.
      if (path.startsWith("/admin/order-sync")) {
        if (!adminOk(req)) {
          send(res, adminToken ? 401 : 404, { error: adminToken ? "invalid admin token" : "not found" });
          return;
        }
        if (!rateLimitOk(clientIp(req))) {
          send(res, 429, { error: "rate limit exceeded" });
          return;
        }
        if (path === "/admin/order-sync/status" && req.method === "GET") {
          send(res, 200, orderSync.status());
          return;
        }
        if (path === "/admin/order-sync/run" && req.method === "POST") {
          const body = await readBody(req);
          const out = await orderSync.runOnce({ dryRun: body.dry_run === true ? true : undefined });
          send(res, 200, out);
          return;
        }
        send(res, 404, { error: "not found" });
        return;
      }

      if (!path.startsWith("/proxy/quotes")) {
        send(res, 404, { error: "not found" });
        return;
      }

      // Rate limit first: floods get throttled regardless of signature state.
      if (!rateLimitOk(clientIp(req))) {
        send(res, 429, { error: "rate limit exceeded (60 req/min per source IP)" });
        return;
      }

      // App-proxy signature verification (production). Local dev: skip with warning.
      if (cfg.shopify.appSecret && !verifyProxySignature(query, cfg.shopify.appSecret)) {
        send(res, 401, { error: "invalid proxy signature" });
        return;
      }

      const parts = path.split("/").filter(Boolean); // ["proxy","quotes", maybe ":ref", maybe ":action"]
      const ref = parts[2] ? decodeURIComponent(parts[2]) : null;
      const action = parts[3] || null;

      // P1: token-gated shared quote view — no email, the token is the capability.
      // Wave-1: also resolves ephemeral 15-min preview tokens (preview.js).
      if (ref === "shared" && action && req.method === "GET" && parts.length === 4) {
        send(res, 200, await svc.getSharedQuote(decodeURIComponent(action)));
        return;
      }

      // Wave-1 (P2-3): shared-link PDF — masked per the token's stored mode.
      // A "none" share yields a PDF with no prices and no totals anywhere.
      if (ref === "shared" && action && parts[4] === "pdf" && req.method === "GET") {
        sendPdf(res, await svc.getSharedQuotePdf(decodeURIComponent(action)));
        return;
      }

      // Wave-1: manual expiring-email sweep trigger (signature-protected like
      // every proxy route; the 12h in-process interval is the normal driver).
      if (ref === "ops" && action === "sweep" && req.method === "POST") {
        send(res, 200, await svc.sweepExpiringQuotes());
        return;
      }

      // Wave-1: SKU/name typeahead for quote-detail Quick Add.
      if (ref === "sku-search" && !action && req.method === "GET") {
        send(res, 200, { results: skuMap.search(query.q || "", 8) });
        return;
      }

      // ----- Wave-2A routes (job-scoped reorder + save-cart-as-quote) -----

      // Wave-2A (P2-11): reorder history — past converted quotes + order
      // history, searchable by quote name / PO / job name / order #.
      // TRUST: same email-identity model as the quotes list (see reorder.js).
      if (ref === "reorder" && action === "history" && req.method === "GET") {
        requireEmail(query);
        send(res, 200, await w2a.reorderHistory(query.email, query.q || ""));
        return;
      }

      // Wave-2A (P2-11): execute a reorder. Honored original pricing via a new
      // quote when every item still exists; current-price cart permalink with
      // a visible "prices updated" notice when anything changed.
      if (ref === "reorder" && !action && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await w2a.reorder(body.email, body.source || {}));
        return;
      }

      // Wave-2A (P2-5): Save Cart as Quote — COPY semantics: the cart is never
      // emptied; only sku+qty are accepted from the client (prices are
      // computed server-side at quote time — client prices are ignored).
      if (ref === "from-cart" && !action && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await w2a.saveCartAsQuote(body.email, body));
        return;
      }

      // Wave-2B (P2-12): RETIRED approve-link target. Owner ruling
      // 2026-10-08: quotes are flagged for staff attention, NEVER blocked —
      // the single-use approve-token machinery was dropped. Any old emailed
      // link gets a clear 410 Gone page; nothing is gated anymore.
      if (ref === "approve" && !action && req.method === "GET") {
        sendHtml(res, 410, {
          ok: false,
          title: "Approval links are no longer used",
          message: "Quotes are never blocked pending approval — they convert freely. " +
            "Our team is notified internally about large quotes. If you reached this page " +
            "from an older email, no action is needed.",
        });
        return;
      }

      // Wave-2B (#109): customer part-number aliases (self-service per email).
      if (ref === "aliases" && !action && req.method === "GET") {
        requireEmail(query);
        send(res, 200, await svc.listAliases(query.email));
        return;
      }
      if (ref === "aliases" && !action && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.addAlias(body.email, body.customer_sku, body.our_sku));
        return;
      }
      if (ref === "aliases" && action === "remove" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.removeAlias(body.email, body.customer_sku));
        return;
      }

      if (!ref && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        const out = await svc.createQuote({
          email: body.email,
          name: body.name,
          displayName: body.display_name,
          customerId: body.customer_id,
          line: body.line,
        });
        send(res, 200, out);
        return;
      }

      if (!ref && req.method === "GET") {
        requireEmail(query);
        send(res, 200, await svc.listQuotes(query.email));
        return;
      }

      if (ref && !action && req.method === "GET") {
        requireEmail(query);
        send(res, 200, await svc.getQuote(query.email, ref));
        return;
      }

      if (ref && action === "rename" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.renameQuote(body.email, ref, body.name));
        return;
      }

      if (ref && action === "lines" && parts[4] === "bulk" && req.method === "POST") {
        // Wave-1 (P2-10): bulk paste/CSV quick-add. confirm falsy => preview
        // (zero writes); confirm:true => one idempotent batch commit.
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.bulkAddLines(body.email, ref, {
          text: body.text,
          lines: body.lines,
          confirm: body.confirm === true,
        }));
        return;
      }

      if (ref && action === "lines" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.mutateLine(body.email, ref, body));
        return;
      }

      if (ref && action === "convert" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        const out = await svc.convertQuote(body.email, ref);
        // Wave-2A: a successful conversion (permalink issued) marks the quote
        // as a "past converted quote" on the reorder surface. Fire-and-forget;
        // a failure here never breaks the conversion itself.
        w2a.recordConversion(body.email, ref, out).catch(() => {});
        send(res, 200, out);
        return;
      }

      if (ref && action === "expire-refresh" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.refreshExpiry(body.email, ref));
        return;
      }

      // ----- P1 routes -----

      if (ref && action === "delete" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        if (body.confirm !== true) throw new HttpError(400, "delete requires confirm:true (cannot undo)");
        send(res, 200, await svc.deleteQuote(body.email, ref));
        return;
      }

      if (ref && action === "share" && req.method === "POST" && parts.length === 4) {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.shareQuote(body.email, ref, { mode: body.mode, note: body.note }));
        return;
      }

      if (ref && action === "share" && parts[4] === "revoke" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.revokeShare(body.email, ref, { token: body.token }));
        return;
      }

      // ----- Wave-1 routes -----

      if (ref && action === "copy" && req.method === "POST") {
        // Make a Copy: new quote #, fresh 7-day validity, lines + PO/Job + notes carry.
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.copyQuote(body.email, ref));
        return;
      }

      if (ref && action === "preview" && req.method === "POST") {
        // Preview as client: ephemeral 15-min token for the recipient view.
        // Never creates/revokes a real share link.
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.previewQuote(body.email, ref, { mode: body.mode, note: body.note }));
        return;
      }

      if (ref && action === "pdf" && req.method === "GET") {
        // Wave-1 (P2-3): owner PDF download. ?mode=full|price_only|none
        // (default full) mirrors the Lowe's Download dialog masking modes.
        requireEmail(query);
        sendPdf(res, await svc.getQuotePdf(query.email, ref, { mode: query.mode || "full" }));
        return;
      }

      send(res, 404, { error: "not found" });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      if (!(e instanceof HttpError)) console.error("[proxy] upstream error:", e.message);
      send(res, status, { error: e.message, degraded: status === 502 });
    }
  });

  server.listen(cfg.port, () => {
    console.log(`[proxy] PES quote proxy listening on http://localhost:${cfg.port} (dev)`);
  });
}

function requireEmail(obj) {
  if (!obj || !obj.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(obj.email))) {
    throw new HttpError(400, "a valid email is required (guest quotes are captured by email)");
  }
}

main().catch((e) => {
  console.error("[proxy] fatal:", e.message);
  process.exit(1);
});
