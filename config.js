"use strict";
/*
 * config.js — runtime configuration for the PES quote proxy backend.
 *
 * Axis (Odoo 19) credentials come from environment variables following the
 * repo-wide pattern (ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY). If
 * ODOO_API_KEY is absent, we fetch it at runtime from Azure Key Vault via the
 * authenticated az CLI (kv-riven-ops-eus / Riven-ERP-Api-Password).
 *
 * The secret is held in memory only. It is NEVER printed, logged, or written
 * to disk by this code.
 */

const { execSync } = require("child_process");

const KEYVAULT_NAME = process.env.AZURE_KEYVAULT_NAME || "kv-riven-ops-eus";
const KEYVAULT_SECRET = process.env.AZURE_KEYVAULT_SECRET || "Riven-ERP-Api-Password";

let cachedKey = null;

function fetchKeyFromVault() {
  if (cachedKey) return cachedKey;
  // Constants only (no user input) — safe to run through the shell, which
  // Windows needs in order to resolve az.cmd. Try PATH first, then the
  // standard MSI install location.
  const azBin = process.platform === "win32"
    ? [ "az", `"${process.env["ProgramFiles"] || "C:\\Program Files"}\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"` ]
    : [ "az" ];
  let out = null;
  let lastErr = null;
  for (const bin of azBin) {
    const cmd = `${bin} keyvault secret show --vault-name ${KEYVAULT_NAME} -n ${KEYVAULT_SECRET} --query value -o tsv`;
    try {
      out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (out === null) {
    const e = lastErr || new Error("az not found");
    const stderr = e.stderr ? String(e.stderr).slice(0, 300) : String(e.message);
    throw new Error(
      "Failed to read Axis credential from Azure Key Vault " +
        `(vault=${KEYVAULT_NAME}, secret=${KEYVAULT_SECRET}). ` +
        "Set ODOO_API_KEY in the environment instead. az stderr: " + stderr
    );
  }
  const key = out.trim();
  if (!key) throw new Error("Azure Key Vault returned an empty secret.");
  cachedKey = key;
  return key;
}

function loadConfig() {
  const apiKey = process.env.ODOO_API_KEY || fetchKeyFromVault();
  return {
    odoo: {
      url: (process.env.ODOO_URL || "https://axis.pesdistribution.com").replace(/\/+$/, ""),
      db: process.env.ODOO_DB || "riven_erp_pes",
      user: process.env.ODOO_USER || "admin",
      apiKey,
    },
    shopify: {
      // App-proxy HMAC secret. When unset the server runs in local dev mode
      // and logs a warning instead of verifying signatures.
      appSecret: process.env.SHOPIFY_APP_SECRET || null,
      shopDomain: process.env.SHOP_DOMAIN || "portlandiaelectricsupply.myshopify.com",
    },
    port: parseInt(process.env.PORT || "8787", 10),
    quoteValidityDays: parseInt(process.env.QUOTE_VALIDITY_DAYS || "7", 10),
    driftReviewPct: parseFloat(process.env.DRIFT_REVIEW_PCT || "0.03"), // >3% drift => interstitial
    // Display-only volume-pricing progress bar (P1). The discount itself stays
    // an Axis pricelist decision; bar hidden on contract-priced quotes.
    volumeThreshold: parseFloat(process.env.VOLUME_THRESHOLD || "2000"),
    // Quote lifecycle emails (Wave-1). THE mail rail switch: RESEND_API_KEY.
    // Without it the mailer composes + queues to data/email-outbox.json and
    // sends NOTHING (stubbed). MAIL_FROM defaults to the sales@ mailbox used
    // by the three live order-notification templates (DMARC is set).
    resendApiKey: process.env.RESEND_API_KEY || null,
    mailFrom: process.env.MAIL_FROM || "PES Supply <sales@portlandiaelectric.supply>",
    storefrontUrl: (process.env.STOREFRONT_URL || "https://www.portlandiaelectric.supply").replace(/\/+$/, ""),
    // Wave-2B (P2-12): quote approval threshold. A quote whose total reaches
    // this amount enters "pending approval" at conversion time; the approver
    // gets an outbox email with a single-use 72h approve link. <= 0 disables
    // the gate. Unknown approval state fails CLOSED (not convertible).
    quoteApprovalMin: parseFloat(process.env.QUOTE_APPROVAL_MIN || "10000"),
    quoteApproverEmail: process.env.QUOTE_APPROVER_EMAIL || "sales@portlandiaelectric.supply",
  };
}

module.exports = { loadConfig };
