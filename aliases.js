"use strict";
/*
 * aliases.js — Wave-2B (#109) customer part-number aliasing.
 *
 * The contractor lock-in feature from the electrical-distribution teardown:
 * every serious distributor (Wesco, Elliott, Crescent, Border States) lets the
 * buyer work in THEIR OWN part numbers. Ours maps:
 *
 *     customer_email + customer_sku  ->  our_sku
 *
 * Resolution order in the bulk quick-add: customer alias FIRST, then the
 * catalog SKU map (a customer part number that happens to collide with a real
 * SKU resolves to the alias — the customer's own numbering always wins for
 * that customer).
 *
 * Store: data/customer-aliases.json (container-fs, same persistence model as
 * share-tokens.json — LOST on container group recreation; RECREATION CAVEAT:
 * aliases are user data and must be re-entered (or restored from a future
 * persistent mount) after a recreation. Same documented limitation as the
 * share/preview token stores; Azure Files mount for data/ is still pending
 * storage perms).
 *
 *   { "<email_lc>": { "<CUSTOMER_SKU_UPPER>": { our_sku, created_at } } }
 */

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "data", "customer-aliases.json");
const MAX_LEN = 64;

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function normSku(sku) {
  return String(sku || "").trim().toUpperCase();
}

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

/** All aliases for one customer, newest last: [{customer_sku, our_sku, created_at}] */
function listForEmail(email) {
  const rows = loadStore()[normEmail(email)] || {};
  return Object.keys(rows)
    .sort()
    .map((k) => ({ customer_sku: k, our_sku: rows[k].our_sku, created_at: rows[k].created_at }));
}

/** { CUSTOMER_SKU: our_sku } lookup map for one customer. */
function mapForEmail(email) {
  const rows = loadStore()[normEmail(email)] || {};
  const out = {};
  for (const k of Object.keys(rows)) out[k] = rows[k].our_sku;
  return out;
}

/** Reverse map { OUR_SKU: customer_sku } for line/PDF display. First alias wins. */
function reverseMapForEmail(email) {
  const rows = loadStore()[normEmail(email)] || {};
  const out = {};
  for (const k of Object.keys(rows).sort()) {
    const our = normSku(rows[k].our_sku);
    if (!(our in out)) out[our] = k;
  }
  return out;
}

/** Resolve one token for a customer. Returns our_sku or null. */
function resolve(email, customerSku) {
  const rows = loadStore()[normEmail(email)];
  if (!rows) return null;
  const rec = rows[normSku(customerSku)];
  return rec ? rec.our_sku : null;
}

/**
 * Add or overwrite one alias. Overwriting is the update path (a contractor
 * correcting a mapping). Returns the stored row.
 */
function addAlias(email, customerSku, ourSku) {
  const em = normEmail(email);
  const cs = normSku(customerSku);
  const os = String(ourSku || "").trim();
  if (!em) { const e = new Error("email is required"); e.status = 400; throw e; }
  if (!cs || cs.length > MAX_LEN) { const e = new Error("your part number is required (max 64 chars)"); e.status = 400; throw e; }
  if (!os || os.length > MAX_LEN) { const e = new Error("our SKU is required (max 64 chars)"); e.status = 400; throw e; }
  const store = loadStore();
  if (!store[em]) store[em] = {};
  store[em][cs] = { our_sku: os, created_at: new Date().toISOString() };
  saveStore(store);
  return { customer_sku: cs, our_sku: os, created_at: store[em][cs].created_at };
}

/** Remove one alias. Returns true when a row was removed. */
function removeAlias(email, customerSku) {
  const store = loadStore();
  const em = normEmail(email);
  const cs = normSku(customerSku);
  if (!store[em] || !store[em][cs]) return false;
  delete store[em][cs];
  if (!Object.keys(store[em]).length) delete store[em];
  saveStore(store);
  return true;
}

module.exports = { STORE_PATH, listForEmail, mapForEmail, reverseMapForEmail, resolve, addAlias, removeAlias };
