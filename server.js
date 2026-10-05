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
 *   GET  /proxy/quotes/shared/:token         token-gated masked view, NO email (P1)
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

async function main() {
  const cfg = loadConfig();
  const axis = new AxisClient(cfg.odoo);
  const svc = new QuoteService(axis, cfg);

  if (!cfg.shopify.appSecret) {
    console.warn("[proxy] SHOPIFY_APP_SECRET not set — LOCAL DEV MODE, proxy signatures not verified");
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      const path = u.pathname.replace(/\/+$/, "") || "/";
      const query = Object.fromEntries(u.searchParams.entries());

      if (path === "/healthz" && req.method === "GET") {
        send(res, 200, { ok: true, sku_map: skuMap.stats(), dev_mode: !cfg.shopify.appSecret });
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
      if (ref === "shared" && action && req.method === "GET" && parts.length === 4) {
        send(res, 200, await svc.getSharedQuote(decodeURIComponent(action)));
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

      if (ref && action === "lines" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.mutateLine(body.email, ref, body));
        return;
      }

      if (ref && action === "convert" && req.method === "POST") {
        const body = await readBody(req);
        requireEmail(body);
        send(res, 200, await svc.convertQuote(body.email, ref));
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
