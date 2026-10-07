"use strict";
/*
 * bulk.js — Wave-1 (P2-10 BEAT) bulk paste/CSV quick-add parsing + resolution.
 *
 * Lowe's has only a single-item typeahead — no paste-multiple exists (pass 2).
 * Contractors think in BOMs: a paste box accepting `SKU,qty` lines, tolerant of
 * CSV / TSV / plain whitespace, with per-line failures that fail LOUD and are
 * never silently dropped (spec §7 discipline).
 *
 * Pure functions only — no Axis, no fs — fully unit-testable.
 *
 * Parse rules:
 *   - blank lines are skipped (never an error)
 *   - delimiter per line: TAB wins, then comma, then whitespace runs
 *   - field 1 = SKU (required, <= 64 chars), field 2 = qty (optional, default 1)
 *   - tokens may be wrapped in double quotes (CSV habit)
 *   - more than 2 fields => parse failure "expected: SKU, qty"
 *   - qty must be a finite number > 0
 *   - duplicate SKUs across lines are MERGED (quantities summed, first line
 *     number kept) so a pasted BOM with repeats behaves predictably
 *   - input capped at MAX_BULK_LINES lines (excess reported, never dropped silently)
 */

const MAX_BULK_LINES = 200;

function unquote(tok) {
  const t = String(tok || "").trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).trim();
  return t;
}

function splitLine(line) {
  if (line.indexOf("\t") !== -1) return line.split("\t").map(unquote);
  if (line.indexOf(",") !== -1) return line.split(",").map(unquote);
  return line.split(/\s+/).filter((s) => s.length > 0).map(unquote);
}

/**
 * Parse pasted text into bulk lines.
 * @returns {{ok: Array<{line:number, sku:string, qty:number, merged_from?:number[]}>,
 *            failed: Array<{line:number, raw:string, reason:string}>,
 *            truncated: boolean, total_lines: number}}
 */
function parseBulkLines(text, { maxLines = MAX_BULK_LINES } = {}) {
  const raw = String(text == null ? "" : text);
  const lines = raw.split(/\r\n|\r|\n/);
  const ok = [];
  const failed = [];
  const bySku = new Map(); // sku -> index into ok
  let truncated = false;
  let dataLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine || !rawLine.trim()) continue; // blank: skip silently
    dataLines++;
    if (dataLines > maxLines) {
      truncated = true;
      failed.push({
        line: i + 1,
        raw: rawLine.slice(0, 80),
        reason: `beyond the ${maxLines}-line limit — split the paste into smaller batches`,
      });
      continue;
    }
    const fields = splitLine(rawLine.trim()).filter((f) => f !== "");
    if (!fields.length) continue;
    if (fields.length > 2) {
      failed.push({ line: i + 1, raw: rawLine.slice(0, 80), reason: "could not parse — expected: SKU, qty" });
      continue;
    }
    const sku = fields[0];
    if (!sku || sku.length > 64) {
      failed.push({ line: i + 1, raw: rawLine.slice(0, 80), reason: "missing or over-long SKU" });
      continue;
    }
    let qty = 1;
    if (fields.length === 2) {
      qty = Number(fields[1]);
      if (!Number.isFinite(qty) || qty <= 0) {
        failed.push({ line: i + 1, raw: rawLine.slice(0, 80), reason: `invalid qty "${fields[1]}" — must be a positive number` });
        continue;
      }
    }
    const key = sku.toUpperCase();
    if (bySku.has(key)) {
      const idx = bySku.get(key);
      ok[idx].qty += qty;
      ok[idx].merged_from = (ok[idx].merged_from || []).concat(i + 1);
    } else {
      bySku.set(key, ok.length);
      ok.push({ line: i + 1, sku, qty });
    }
  }
  return { ok, failed, truncated, total_lines: dataLines };
}

/**
 * Validate structured lines (client may send pre-parsed [{sku, qty}] instead of
 * text — the quick-add typeahead reuses this endpoint with a single line).
 * Same failure contract as parseBulkLines, plus duplicate merging.
 */
function parseStructuredLines(lines, { maxLines = MAX_BULK_LINES } = {}) {
  const ok = [];
  const failed = [];
  const bySku = new Map();
  const arr = Array.isArray(lines) ? lines : [];
  arr.forEach((l, i) => {
    const lineNo = i + 1;
    if (lineNo > maxLines) {
      failed.push({ line: lineNo, raw: JSON.stringify(l).slice(0, 80), reason: `beyond the ${maxLines}-line limit` });
      return;
    }
    const sku = l && l.sku != null ? String(l.sku).trim() : "";
    if (!sku || sku.length > 64) {
      failed.push({ line: lineNo, raw: JSON.stringify(l).slice(0, 80), reason: "missing or over-long SKU" });
      return;
    }
    const qty = l.qty == null ? 1 : Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      failed.push({ line: lineNo, raw: JSON.stringify(l).slice(0, 80), reason: "qty must be a positive number" });
      return;
    }
    const key = sku.toUpperCase();
    if (bySku.has(key)) {
      ok[bySku.get(key)].qty += qty;
    } else {
      bySku.set(key, ok.length);
      ok.push({ line: lineNo, sku, qty });
    }
  });
  return { ok, failed, truncated: false, total_lines: arr.length };
}

/**
 * Resolve parsed lines against the SKU map (24,340-entry Shopify catalog map).
 * Pure: `lookup` is injected (skuMap.lookup in production, a stub in tests).
 * Resolved entries carry catalog title/price/freight for the preview table;
 * failures are listed with a reason — never silently dropped.
 */
function resolveBulk(parsed, lookup) {
  const resolved = [];
  const failed = parsed.failed.slice();
  for (const l of parsed.ok) {
    const m = lookup(l.sku);
    if (!m) {
      failed.push({ line: l.line, raw: `${l.sku}, ${l.qty}`, sku: l.sku, reason: "SKU not found in the catalog" });
      continue;
    }
    resolved.push({
      line: l.line,
      sku: l.sku,
      qty: l.qty,
      title: m.title || null,
      shopify_price: Number.isFinite(Number(m.shopify_price)) ? Number(m.shopify_price) : null,
      freight: !!m.freight,
      // Wave-2B (#109): present when the line matched via a customer alias.
      ...(l.customer_sku ? { customer_sku: l.customer_sku, via_alias: true } : {}),
    });
  }
  return { resolved, failed };
}

module.exports = { MAX_BULK_LINES, parseBulkLines, parseStructuredLines, resolveBulk };
