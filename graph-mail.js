"use strict";
/*
 * graph-mail.js — Microsoft Graph sendMail sender adapter (app-only,
 * client credentials). Zero dependencies (Node stdlib https).
 *
 * Credentials come from env (wired as ACI secure env vars from Azure Key
 * Vault kv-riven-ops-eus at deploy time; secret names there are
 * RIVEN-CONNECTOR-GRAPH-TENANT-ID / -CLIENT-ID / -CLIENT-SECRET — the
 * RIVEN-GRAPH-* set has no tenant-id secret, so the complete connector set
 * is used). Values are NEVER logged or persisted by this code.
 *
 * Sender mailbox: GRAPH_MAILBOX (default pes.sales@bsdyno.com — the mailbox
 * that carries smtp:sales@portlandiaelectric.supply as a proxy alias,
 * discovered 2026-10-08 via Graph proxyAddresses query). The visible From is
 * GRAPH_FROM_ADDRESS (default sales@portlandiaelectric.supply) — Exchange
 * Online resolves the alias on that mailbox; DMARC/DKIM already aligned.
 *
 * Behavior:
 *   - token cached in memory, refreshed 5 min before expiry
 *   - 15 s timeout; ONE retry on network error / 429 / 5xx (never on 4xx auth)
 *   - sendMail success = HTTP 202 with empty body (no message id returned)
 *   - errors throw loud with status + body snippet (mailer.js catches and
 *     records send-error rows; nothing throws into the quote flow)
 *
 * createGraphSender() returns null when env is incomplete — the caller
 * (mailer.js) then falls back to the existing stubbed outbox behavior.
 */

const https = require("https");

function post(urlStr, { headers = {}, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function postWithRetry(urlStr, opts, { retryable }) {
  try {
    const res = await post(urlStr, opts);
    if (retryable(res.status)) {
      await new Promise((r) => setTimeout(r, 1500));
      return await post(urlStr, opts); // one retry, then whatever happens
    }
    return res;
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1500));
    return await post(urlStr, opts); // network error: one retry
  }
}

/** Build the Graph message payload. Pure — exported for unit tests. */
function buildMessage({ to, subject, html, text, fromAddress }) {
  const recipients = (Array.isArray(to) ? to : [to]).map((addr) => ({
    emailAddress: { address: String(addr) },
  }));
  return {
    message: {
      subject: String(subject || ""),
      // Graph sendMail carries a single body; HTML when we have it.
      body: html
        ? { contentType: "HTML", content: String(html) }
        : { contentType: "Text", content: String(text || "") },
      from: { emailAddress: { address: fromAddress } },
      sender: { emailAddress: { address: fromAddress } },
      toRecipients: recipients,
    },
    saveToSentItems: true,
  };
}

function createGraphSender(env = process.env) {
  const tenantId = env.GRAPH_TENANT_ID;
  const clientId = env.GRAPH_CLIENT_ID;
  const clientSecret = env.GRAPH_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) return null;
  const mailbox = env.GRAPH_MAILBOX || "pes.sales@bsdyno.com";
  const fromAddress = env.GRAPH_FROM_ADDRESS || "sales@portlandiaelectric.supply";

  let cached = null; // { token, expiresAt }

  async function getToken() {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }).toString();
    const res = await postWithRetry(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
      { retryable: (s) => s === 429 || s >= 500 }
    );
    if (res.status !== 200) {
      throw new Error(`Graph token HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }
    const j = JSON.parse(res.text);
    cached = {
      token: j.access_token,
      // refresh 5 min early; default 1 h if expires_in missing
      expiresAt: Date.now() + ((j.expires_in || 3600) - 300) * 1000,
    };
    return cached.token;
  }

  async function send({ to, subject, html, text }) {
    const token = await getToken();
    const payload = JSON.stringify(buildMessage({ to, subject, html, text, fromAddress }));
    const res = await postWithRetry(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: payload,
      },
      { retryable: (s) => s === 429 || s >= 500 }
    );
    if (res.status === 202 || (res.status >= 200 && res.status < 300)) {
      return { id: null }; // sendMail returns 202 + empty body; no message id
    }
    if (res.status === 403) {
      throw new Error(
        "Graph sendMail 403 — app registration is missing Mail.Send application " +
          "permission or admin consent. Grant it in Entra, or unset GRAPH_* to return to the stub."
      );
    }
    throw new Error(`Graph sendMail HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }

  return { name: "graph", send, mailbox, fromAddress };
}

module.exports = { createGraphSender, buildMessage };
