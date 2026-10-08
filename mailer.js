"use strict";
/*
 * mailer.js — quote lifecycle emails: composer + queue + sender.
 *
 * Events: created (to quote owner), shared (to owner, incl. masking mode +
 * link), expiring (day 5 of 7, to owner, convert CTA), converted (to owner).
 *
 * MAIL RAIL — READ THIS FIRST:
 *   The sender is STUBBED unless RESEND_API_KEY is set in the environment.
 *   That single env var is the only switch: with it, messages are sent via
 *   the Resend API (POST https://api.resend.com/emails); without it, every
 *   message is composed fully and appended to data/email-outbox.json with
 *   status "stubbed-no-rail" and a loud log line. NOTHING leaves the box.
 *   As of the Wave-1 build (2026-10-07) no mail credential exists in Azure
 *   Key Vault (kv-riven-ops-eus secret inventory checked) or the container
 *   environment, so the rail is STUBBED in production.
 *
 * Sender identity: sales@portlandiaelectric.supply — consistent with the
 * support mailbox used in the three live order-notification templates
 * (specs/email-templates/backup-pes-2026-09-30). DMARC is set for the
 * domain. Override with MAIL_FROM if a dedicated quotes@ mailbox is
 * provisioned later.
 *
 * Copy rules (binding): never mention suppliers/vendors/dropship/backorder;
 * quotes never promise stock. Style matches the PES order emails: 600px
 * single-column table layout, Arial, inline CSS, preheader, green accents.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUTBOX_PATH = path.join(__dirname, "data", "email-outbox.json");
const ACCENT = "#1d6b3f";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return "$0.00";
  return "$" + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function dateLong(isoDate) {
  if (!isoDate) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = String(isoDate).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(isoDate);
  return `${months[m - 1]} ${d}, ${y}`;
}

const MODE_LABEL = {
  full: "Price and Discounts (quoted prices, savings, and totals visible)",
  price_only: "Price Only (retail prices and totals, no discounts shown)",
  none: "No Price (product names and quantities only)",
};

/* ---------------- shell (shared PES email chrome) ---------------- */

function shell({ title, preheader, bodyHtml, cta, footerNote }) {
  const ctaHtml = cta
    ? `<tr><td align="center" style="padding:24px 32px 4px 32px;">
        <a href="${esc(cta.url)}" style="display:inline-block; background-color:${ACCENT}; color:#ffffff; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:700; text-decoration:none; padding:14px 32px; border-radius:6px; min-width:200px; text-align:center;">${esc(cta.label)}</a>
        ${cta.sub ? `<p style="font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#777777; margin:10px 0 0 0;">${esc(cta.sub)}</p>` : ""}
      </td></tr>`
    : "";
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0; padding:0; background-color:#f2f4f7; -webkit-text-size-adjust:100%;">
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f4f7" style="background-color:#f2f4f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px; max-width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden;">
  <tr><td style="padding:28px 32px 4px 32px;">
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:22px; font-weight:800; color:${ACCENT}; margin-bottom:20px;">PES Supply</div>
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:24px; font-weight:800; color:#111111; line-height:1.25;">${esc(title)}</div>
  </td></tr>
  ${bodyHtml}
  ${ctaHtml}
  <tr><td style="padding:28px 32px 24px 32px; border-top:1px solid #eeeeee; margin-top:24px;">
    <p style="font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#777777; line-height:1.55; margin:16px 0 0 0;">${esc(footerNote || "")}</p>
    <p style="font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#777777; line-height:1.55; margin:8px 0 0 0;">Questions? Reply to this email or write to <a href="mailto:sales@portlandiaelectric.supply" style="color:${ACCENT};">sales@portlandiaelectric.supply</a>.</p>
    <p style="font-family:Arial,Helvetica,sans-serif; font-size:12px; color:#999999; margin:12px 0 0 0;">PES Supply &middot; <a href="https://portlandiaelectric.supply" style="color:#999999;">portlandiaelectric.supply</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function para(text) {
  return `<tr><td style="padding:12px 32px 0 32px;"><p style="font-family:Arial,Helvetica,sans-serif; font-size:15px; color:#444444; line-height:1.55; margin:0;">${text}</p></td></tr>`;
}

function infoBox(html, tone) {
  const bg = tone === "warn" ? "#fdf6ec" : "#f0f7f0";
  const color = tone === "warn" ? "#8a5a00" : "#1b5e20";
  return `<tr><td style="padding:16px 32px 0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background-color:${bg}; border-radius:6px;">
      <tr><td style="padding:12px 16px; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:${color}; line-height:1.5;">${html}</td></tr>
    </table>
  </td></tr>`;
}

/* ---------------- event composers ---------------- */

function compose(event, ctx) {
  // ctx: {email, quote (detail payload), share?{mode, share_path}, storefrontUrl}
  const q = ctx.quote;
  const base = ctx.storefrontUrl || "https://www.portlandiaelectric.supply";
  const quoteUrl = `${base}/pages/quotes?id=${encodeURIComponent(q.id)}`;
  const name = esc(q.name || q.quote_no);
  const expiry = dateLong(q.expiry);

  if (event === "created") {
    const title = `Quote ${q.quote_no} is ready`;
    return {
      subject: `Your quote ${q.quote_no} (${q.name}) is ready — prices held until ${expiry}`,
      html: shell({
        title,
        preheader: `Quote ${q.quote_no}: ${q.name} — estimated total ${money(q.total)}. Prices held until ${expiry}.`,
        bodyHtml:
          para(`Your quote <strong>${name}</strong> (${esc(q.quote_no)}) has been saved with an estimated total of <strong>${money(q.total)}</strong>.`) +
          infoBox(`<strong>Prices held until ${esc(expiry)}</strong> on eligible items. Availability is confirmed at order time — nothing is reserved and no payment is taken at quote time.`) +
          para(`Review your line items, share the quote with your client, or start checkout whenever you're ready. Making changes restarts the 7-day price hold — your quote number stays the same.`),
        cta: { url: quoteUrl, label: "View your quote", sub: "Edit, share, download the PDF, or convert to checkout." },
        footerNote: `Prices held until ${expiry} on eligible items. Availability confirmed at order time.`,
      }),
      text: `Quote ${q.quote_no} (${q.name}) is ready. Estimated total ${money(q.total)}. Prices held until ${expiry}. View: ${quoteUrl}`,
    };
  }

  if (event === "shared") {
    const mode = ctx.share && ctx.share.mode;
    const shareUrl = base + (ctx.share ? ctx.share.share_path : "");
    const title = `You shared quote ${q.quote_no}`;
    return {
      subject: `Quote ${q.quote_no} (${q.name}) shared — ${MODE_LABEL[mode] ? mode.replace("_", " ") : "link created"}`,
      html: shell({
        title,
        preheader: `Share link for quote ${q.quote_no} created with ${mode} visibility.`,
        bodyHtml:
          para(`A share link for <strong>${name}</strong> (${esc(q.quote_no)}) was created from your account. Anyone with the link can view the quote — no sign-in needed.`) +
          infoBox(`<strong>Price visibility:</strong> ${esc(MODE_LABEL[mode] || mode)}`) +
          para(`Link: <a href="${esc(shareUrl)}" style="color:${ACCENT};">${esc(shareUrl)}</a>`) +
          para(`Forward this link to your client. Generating a new link or revoking from the quote page disables all previous links for this quote.`),
        cta: { url: quoteUrl, label: "Manage this quote", sub: "Revoke the link or change the visibility mode anytime." },
        footerNote: `Prices held until ${expiry} on eligible items. Availability confirmed at order time.`,
      }),
      text: `You shared quote ${q.quote_no} (${q.name}). Price visibility: ${MODE_LABEL[mode] || mode}. Link: ${shareUrl}. Manage: ${quoteUrl}`,
    };
  }

  if (event === "expiring") {
    const title = `Quote ${q.quote_no} expires in 2 days`;
    return {
      subject: `Prices on quote ${q.quote_no} (${q.name}) are held until ${expiry} — 2 days left`,
      html: shell({
        title,
        preheader: `Quote ${q.quote_no} expires ${expiry}. Convert it to checkout to lock in your items.`,
        bodyHtml:
          para(`Your quote <strong>${name}</strong> (${esc(q.quote_no)}, estimated total <strong>${money(q.total)}</strong>) expires on <strong>${esc(expiry)}</strong>.`) +
          infoBox(`<strong>2 days left.</strong> After ${esc(expiry)}, quoted prices are no longer held and items reprice at checkout.`, "warn") +
          para(`Ready to buy? Convert the quote to your cart and check out — your card is authorized but not charged until we confirm your order. Need more time? Open the quote and make any change (or use Request Re-quote after expiry) to restart the 7-day hold.`),
        cta: { url: quoteUrl, label: "Review & convert to checkout", sub: "One click from the quote page — no payment taken until order confirmation." },
        footerNote: `Prices held until ${expiry} on eligible items. Availability confirmed at order time.`,
      }),
      text: `Quote ${q.quote_no} (${q.name}) expires ${expiry} — 2 days left. Convert to checkout: ${quoteUrl}`,
    };
  }

  if (event === "converted") {
    const title = `Quote ${q.quote_no} converted to your cart`;
    return {
      subject: `Quote ${q.quote_no} (${q.name}) converted — complete checkout to confirm`,
      html: shell({
        title,
        preheader: `Quote ${q.quote_no} is in your cart. Checkout confirms availability and finalizes your order.`,
        bodyHtml:
          para(`<strong>${name}</strong> (${esc(q.quote_no)}) was converted to a shopping cart. ` +
            (ctx.cartUrl ? `If you didn't finish checkout, your cart is waiting.` : ``)) +
          infoBox(`<strong>What happens next:</strong> at checkout your card is authorized but <strong>not charged</strong> until we confirm your order. Most orders confirm within 1 business day — we'll email you the moment it's locked in.`) +
          para(`Taxes and delivery fees are calculated at checkout. Freight items, if any, are scheduled with you after confirmation.`),
        cta: ctx.cartUrl
          ? { url: ctx.cartUrl, label: "Return to checkout", sub: "Authorized after confirmation — never charged at quote time." }
          : { url: quoteUrl, label: "View the quote", sub: null },
        footerNote: `This quote is now marked converted. A copy remains on your My Quotes page for your records. Availability is confirmed at order time — nothing is reserved until checkout is complete.`,
      }),
      text: `Quote ${q.quote_no} (${q.name}) converted to cart. ${ctx.cartUrl ? "Checkout: " + ctx.cartUrl : ""}`,
    };
  }

  if (event === "quote_flagged") {
    // Wave-2B owner ruling (2026-10-08): FLAG, never block. Staff notification
    // (to QUOTE_FLAG_EMAIL) that a quote crossed the flag threshold. There is
    // NO approve link and NO action gating — conversion is never blocked.
    const customer = ctx.customerEmail || "the customer";
    const title = `Quote ${q.quote_no} flagged for staff attention`;
    return {
      subject: `Flagged for review: quote ${q.quote_no} (${q.name}) — estimated total ${money(q.total)}`,
      html: shell({
        title,
        preheader: `Quote ${q.quote_no} from ${customer} crossed the flag threshold. The customer is NOT blocked.`,
        bodyHtml:
          para(`<strong>${name}</strong> (${esc(q.quote_no)}), requested by <strong>${esc(customer)}</strong>, has an estimated total of <strong>${money(q.total)}</strong>` +
            (ctx.threshold ? ` — over the <strong>${money(ctx.threshold)}</strong> flag threshold` : "") +
            `. It has been flagged for staff attention on the ERP and sales channel. <strong>Conversion is not blocked</strong> — the customer can check out freely.`) +
          infoBox(`<strong>${esc(q.quote_no)}</strong> &middot; ${name} &middot; ${(q.lines || []).length} line item${(q.lines || []).length === 1 ? "" : "s"} &middot; estimated total <strong>${money(q.total)}</strong><br>` +
            `Customer: ${esc(customer)}${q.expiry ? ` &middot; prices held until ${esc(expiry)}` : ""}`) +
          para(`Suggested follow-up: reach out proactively — pricing help, availability confirmation, or freight planning. Find the quote in Axis by quote number.`),
        cta: null,
        footerNote: `This is an internal staff notification. No approval action is required; quotes of any size convert freely.`,
      }),
      text: `Quote ${q.quote_no} (${q.name}) from ${customer} flagged for staff attention — ${money(q.total)} over threshold. Conversion NOT blocked; no action required.`,
    };
  }

  throw new Error(`unknown email event: ${event}`);
}

/* ---------------- outbox (queue + audit) ---------------- */

function loadOutbox() {
  try {
    return JSON.parse(fs.readFileSync(OUTBOX_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveOutbox(rows) {
  fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
  const tmp = OUTBOX_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, OUTBOX_PATH);
}

function appendOutbox(row) {
  const rows = loadOutbox();
  rows.push(row);
  // Keep the file bounded: retain the newest 1000 rows.
  saveOutbox(rows.slice(-1000));
}

/* ---------------- sender (Resend when configured, STUB otherwise) ---------------- */

function postResend(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        method: "POST",
        hostname: "api.resend.com",
        path: "/emails",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
          } else {
            reject(new Error(`Resend HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Resend request timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

class Mailer {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.from = this.cfg.mailFrom || "PES Supply <sales@portlandiaelectric.supply>";
    this.storefrontUrl = this.cfg.storefrontUrl || "https://www.portlandiaelectric.supply";
    this.apiKey = this.cfg.resendApiKey || null;
    if (!this.apiKey) {
      console.warn(
        "[mailer] *** MAIL RAIL STUBBED — RESEND_API_KEY is not set. " +
        "Quote lifecycle emails are composed and queued to data/email-outbox.json but NOTHING is sent. " +
        "Set RESEND_API_KEY (and optionally MAIL_FROM) to turn the rail on. ***"
      );
    }
  }

  railStatus() {
    return this.apiKey ? "resend" : "stubbed-no-rail";
  }

  /**
   * Compose + deliver (or queue) one lifecycle email. NEVER throws into the
   * quote flow: errors are caught, logged, and recorded in the outbox.
   * dedupeKey (optional) suppresses repeat sends of the same logical email
   * (used by the day-5-of-7 expiring sweep).
   */
  async queue(event, ctx, { to, dedupeKey } = {}) {
    const recipient = to || ctx.email;
    if (!recipient) return { status: "skipped-no-recipient" };
    let msg;
    try {
      msg = compose(event, { ...ctx, storefrontUrl: this.storefrontUrl });
    } catch (e) {
      console.error("[mailer] compose failed:", e.message);
      return { status: "compose-error", error: e.message };
    }
    const row = {
      ts: new Date().toISOString(),
      event,
      to: recipient,
      subject: msg.subject,
      dedupe_key: dedupeKey || null,
      html: msg.html,
      text: msg.text,
    };

    if (dedupeKey) {
      const dup = loadOutbox().some((r) => r.dedupe_key === dedupeKey && r.status !== "send-error");
      if (dup) return { status: "deduped" };
    }

    if (!this.apiKey) {
      row.status = "stubbed-no-rail";
      appendOutbox(row);
      console.log(`[mailer] STUBBED (no RESEND_API_KEY) — queued ${event} to ${recipient}: "${msg.subject}"`);
      return { status: "stubbed-no-rail" };
    }

    try {
      const res = await postResend(this.apiKey, {
        from: this.from,
        to: [recipient],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
      row.status = "sent";
      row.provider_id = res && res.id ? res.id : null;
      appendOutbox(row);
      console.log(`[mailer] sent ${event} to ${recipient} (id ${row.provider_id})`);
      return { status: "sent", id: row.provider_id };
    } catch (e) {
      row.status = "send-error";
      row.error = e.message;
      appendOutbox(row);
      console.error(`[mailer] send failed for ${event} to ${recipient}:`, e.message);
      return { status: "send-error", error: e.message };
    }
  }
}

module.exports = { Mailer, compose, MODE_LABEL };
