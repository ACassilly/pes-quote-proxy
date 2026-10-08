"use strict";
/*
 * intercom.js — Wave-2B owner ruling: staff flag notification on Intercom.
 *
 * INTERCOM RAIL — LIVE SINCE 2026-10-08:
 *   INTERCOM_TOKEN + INTERCOM_ADMIN_ID are set as ACI env vars (token sourced
 *   from Azure KV `intercom-access-token`, workspace lt1fbeyf, authenticates
 *   as alex@pes.supply). Without the token every notification is composed and
 *   appended to data/intercom-outbox.json with status "stubbed-no-token";
 *   with it, notes post for real (status "posted", provider_id = note id).
 *
 * Live behavior: find the contact by email (POST /contacts/search); if
 * missing, create a lead contact (the flagging customer is by definition
 * engaged). The note is created CONTACT-SCOPED — POST /contacts/{id}/notes;
 * the legacy global POST /notes path 404s on this workspace (verified
 * 2026-10-08). Notes are authored by INTERCOM_ADMIN_ID (alex@pes.supply =
 * 11175212).
 *
 * Errors NEVER throw into the quote flow.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUTBOX_PATH = path.join(__dirname, "data", "intercom-outbox.json");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return "$0.00";
  return "$" + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function loadOutbox() {
  try { return JSON.parse(fs.readFileSync(OUTBOX_PATH, "utf8")); } catch { return []; }
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
  saveOutbox(rows.slice(-1000));
}

/** Pure composer (unit-tested). Internal staff language — never customer-facing. */
function composeFlagNote({ quote, customerEmail, threshold, flaggedAt }) {
  const q = quote || {};
  const body =
    `<p><strong>Quote flagged for staff attention</strong> (conversion NOT blocked — customer may already have checked out).</p>` +
    `<p>Quote <strong>${esc(q.quote_no)}</strong> (${esc(q.name || "")}) — estimated total <strong>${money(q.total)}</strong>, ` +
    `over the ${money(threshold)} flag threshold.<br>` +
    `Customer: ${esc(customerEmail || "unknown")} &middot; flagged at ${esc(flaggedAt || new Date().toISOString())}<br>` +
    `Items: ${(q.lines || []).length} line(s)${q.expiry ? ` &middot; prices held until ${esc(q.expiry)}` : ""}</p>` +
    `<p>Action: reach out proactively (pricing help, availability confirmation, freight planning). Find the quote in Axis by quote number.</p>`;
  return {
    subject: `Quote ${q.quote_no} flagged for staff attention — ${money(q.total)}`,
    body,
    text: `Quote ${q.quote_no} (${q.name || ""}) from ${customerEmail || "unknown"} flagged: ${money(q.total)} over ${money(threshold)} threshold. Conversion NOT blocked.`,
  };
}

function postJson(token, pathName, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        method: "POST",
        hostname: "api.intercom.io",
        path: pathName,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Intercom-Version": "2.11",
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
            reject(new Error(`Intercom HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Intercom request timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

class IntercomFlag {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.token = this.cfg.intercomToken || null;
    this.adminId = this.cfg.intercomAdminId || null;
    if (!this.token) {
      console.warn(
        "[intercom] *** INTERCOM RAIL STUBBED — INTERCOM_TOKEN is not set. " +
        "Quote flag notifications are composed to data/intercom-outbox.json but NOTHING is posted. " +
        "Set INTERCOM_TOKEN (and INTERCOM_ADMIN_ID) to turn the rail on. ***"
      );
    }
  }

  railStatus() {
    return this.token ? "intercom" : "stubbed-no-token";
  }

  /**
   * Compose + post (or queue) a staff flag note. NEVER throws into the quote
   * flow. dedupeKey suppresses repeats (one note per flagged quote).
   */
  async notifyFlag(ctx, { dedupeKey } = {}) {
    let msg;
    try {
      msg = composeFlagNote(ctx);
    } catch (e) {
      console.error("[intercom] compose failed:", e.message);
      return { status: "compose-error", error: e.message };
    }
    const row = {
      ts: new Date().toISOString(),
      type: "quote-flag",
      subject: msg.subject,
      body: msg.body,
      text: msg.text,
      customer_email: ctx && ctx.customerEmail ? ctx.customerEmail : null,
      dedupe_key: dedupeKey || null,
    };
    if (dedupeKey && loadOutbox().some((r) => r.dedupe_key === dedupeKey && r.status !== "send-error")) {
      return { status: "deduped" };
    }

    if (!this.token || !this.adminId) {
      row.status = "stubbed-no-token";
      appendOutbox(row);
      console.log(`[intercom] STUBBED (no INTERCOM_TOKEN) — queued flag note: "${msg.subject}"`);
      return { status: "stubbed-no-token" };
    }

    try {
      const search = await postJson(this.token, "/contacts/search", {
        query: { field: "email", operator: "=", value: ctx.customerEmail },
      });
      let contact = search && Array.isArray(search.data) && search.data[0];
      if (!contact) {
        // The flagging customer is by definition engaged — create a lead so
        // the staff note has somewhere to live.
        contact = await postJson(this.token, "/contacts", {
          role: "lead",
          email: ctx.customerEmail,
        });
        row.contact_created = true;
      }
      // Contact-scoped notes path — global POST /notes 404s on this workspace
      // (verified 2026-10-08, workspace lt1fbeyf).
      const note = await postJson(this.token, `/contacts/${contact.id}/notes`, {
        admin_id: this.adminId,
        body: msg.body,
      });
      row.status = "posted";
      row.provider_id = note && note.id ? note.id : null;
      row.contact_id = contact.id;
      appendOutbox(row);
      console.log(`[intercom] posted flag note (id ${row.provider_id})`);
      return { status: "posted", id: row.provider_id };
    } catch (e) {
      row.status = "send-error";
      row.error = e.message;
      appendOutbox(row);
      console.error("[intercom] post failed:", e.message);
      return { status: "send-error", error: e.message };
    }
  }
}

module.exports = { IntercomFlag, composeFlagNote, OUTBOX_PATH };
