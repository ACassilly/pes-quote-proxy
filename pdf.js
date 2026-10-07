"use strict";
/*
 * pdf.js — PES-branded quote PDF generator. Zero dependencies (Node stdlib).
 *
 * Hand-rolled minimal PDF writer: letter pages, Helvetica/Helvetica-Bold
 * (standard 14 fonts, no embedding), one embedded JPEG logo (DCTDecode —
 * the brand asset is pre-converted at build time and committed to the repo
 * as assets/pes-logo.jpg, pulled from the live Shopify theme logo).
 *
 * Document class copied from the Lowe's quote PDF (lowes-deep2/22-quote-pdf-
 * fence-job.pdf): full commercial document — header with business branding,
 * customer/job fields, quote #, "Quote valid until …", line table with
 * per-line savings, totals with "Estimated Quote Savings" as its own
 * negative line and "Delivery Fees & Taxes — Calculated at Checkout".
 *
 * The four Lowe's legal blocks are REPLACED with OUR terms (spec §5 P2-3):
 *   1. Validity & changes  — prices held until {validity} on eligible items;
 *      changes RESTATE this quote and restart the 7-day hold (D1), the quote
 *      number stays the same.
 *   2. Availability        — subject to item availability at order time,
 *      which is not guaranteed; nothing is reserved.
 *   3. Payment             — authorize-after-confirm: no card is touched at
 *      quote time; authorized but not charged until the order is confirmed;
 *      taxes/delivery calculated at checkout; freight quoted separately.
 *   4. Materials only      — PES materials-only liability shield.
 *   (Lowe's store-binding clause skipped — single-store e-comm.)
 *
 * Masking modes mirror share.js: full / price_only / none. A "none" PDF
 * contains NO prices and NO totals anywhere.
 *
 * renderQuotePdf() is a pure function (unit-tested without Axis).
 */

const fs = require("fs");
const path = require("path");

const ACCENT = [0.106, 0.42, 0.247]; // PES green #1b6b3f
const INK = [0.11, 0.11, 0.11];
const MUTE = [0.42, 0.42, 0.42];

/* ---------------- text helpers ---------------- */

// Map common Unicode punctuation to WinAnsi-safe ASCII, drop the rest.
function sanitize(s) {
  return String(s == null ? "" : s)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00B7/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

function pdfStr(s) {
  return "(" + sanitize(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
}

function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return "$0.00";
  return "$" + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Rough Helvetica advance estimate (fraction of em) — good enough for wraps.
function estWidth(text, size, bold) {
  let w = 0;
  for (const ch of sanitize(text)) {
    if ("ilj.,:;'|! ".includes(ch)) w += 0.28;
    else if ("mwMW@".includes(ch)) w += 0.85;
    else if (ch >= "A" && ch <= "Z") w += 0.66;
    else w += 0.5;
  }
  return w * size * (bold ? 1.04 : 1);
}

function wrap(text, size, maxWidth, bold) {
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of words) {
    const trial = cur ? cur + " " + word : word;
    if (cur && estWidth(trial, size, bold) > maxWidth) {
      lines.push(cur);
      cur = word;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* ---------------- JPEG ---------------- */

function loadLogo() {
  try {
    // The JPEG is committed as base64 text (assets/pes-logo.b64) so the GitHub
    // mirror deploy path never handles binary; decode at boot. Fall back to a
    // raw .jpg when running from a full local checkout.
    let buf;
    const b64Path = path.join(__dirname, "assets", "pes-logo.b64");
    if (fs.existsSync(b64Path)) {
      buf = Buffer.from(fs.readFileSync(b64Path, "utf8").replace(/\s+/g, ""), "base64");
    } else {
      buf = fs.readFileSync(path.join(__dirname, "assets", "pes-logo.jpg"));
    }
    // Parse SOF0/SOF2 for dimensions.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return { data: buf, height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { data: buf, width: 761, height: 184 }; // known fallback
  } catch {
    return null; // PDF still renders (text wordmark fallback)
  }
}

/* ---------------- page painter ---------------- */

class PagePainter {
  constructor() {
    this.ops = [];
  }
  raw(op) { this.ops.push(op); }
  text(x, y, str, { size = 9, bold = false, color = INK } = {}) {
    const font = bold ? "/F2" : "/F1";
    this.ops.push(
      `BT ${font} ${size} Tf ${color.join(" ")} rg ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfStr(str)} Tj ET`
    );
  }
  textRight(x, y, str, opts = {}) {
    const w = estWidth(str, opts.size || 9, opts.bold);
    this.text(x - w, y, str, opts);
  }
  rule(x1, y, x2, { width = 1, color = ACCENT } = {}) {
    this.ops.push(`${color.join(" ")} RG ${width} w ${x1} ${y.toFixed(2)} m ${x2} ${y.toFixed(2)} l S`);
  }
  fillRect(x, y, w, h, color) {
    this.ops.push(`${color.join(" ")} rg ${x} ${y.toFixed(2)} ${w} ${h.toFixed(2)} re f`);
  }
  image(x, y, w, h) {
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x} ${y.toFixed(2)} cm /Im1 Do Q`);
  }
  stream() {
    return Buffer.from(this.ops.join("\n"), "latin1");
  }
}

/* ---------------- document layout ---------------- */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const LEGAL_BLOCKS = [
  {
    title: "Validity & Changes",
    body:
      "Prices on this quote are held until {expiry} (11:59 p.m. PT) on eligible items. " +
      "Any change to this quote - for example adding or removing items or changing quantities - " +
      "restates this quote and restarts the 7-day price hold; your quote number stays the same. " +
      "Additional discounts, if applicable, are calculated at checkout.",
  },
  {
    title: "Availability",
    body:
      "All items are subject to availability at the time of order. Availability is not guaranteed, " +
      "and this quote does not reserve stock. Freight and pallet items are quoted separately. " +
      "PES Supply reserves the right to correct any error and to limit quantities sold.",
  },
  {
    title: "Payment - Authorized After Confirmation",
    body:
      "No payment is taken at quote time. When you check out, your card is authorized but not " +
      "charged until we confirm your order. Taxes and delivery fees are calculated at checkout.",
  },
  {
    title: "Materials Only",
    body:
      "Portlandia Electric Supply (PES Supply) is offering to supply materials only. PES Supply is " +
      "not offering engineering, architecture, or general contracting services or advice, and is " +
      "not responsible for the selection or choice of materials for a general or specific use; " +
      "for quantities or sizing of materials; for the use or installation of materials; or for " +
      "compliance with any building code or standard of workmanship.",
  },
];

function dateLong(isoDate) {
  // "2026-10-07" -> "Oct 7, 2026" (no Date timezone surprises — string math)
  if (!isoDate) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = String(isoDate).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(isoDate);
  return `${months[m - 1]} ${d}, ${y}`;
}

/**
 * Build the page content streams for the quote PDF.
 * quote: detail payload from quotes.js (lines carry title/sku/qty/unit_price/
 *        line_total/list_price/savings_pct).
 * partner: {name, email, phone, street, street2, city, state, zip, country}
 * mode: "full" | "price_only" | "none"
 * Returns { pages: [Buffer, ...], logo: {data,width,height}|null }
 */
function buildPages(quote, partner, mode, logo) {
  const showPrices = mode === "full" || mode === "price_only";
  const showSavings = mode === "full";
  const pages = [];
  let p = new PagePainter();
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    pages.push(p);
    p = new PagePainter();
    y = PAGE_H - MARGIN;
  };
  const ensure = (needed) => {
    if (y - needed < 150) newPage(); // keep room for legal/footer on last page
  };

  /* ---- header ---- */
  const headerTop = y;
  if (logo) {
    const lw = 132;
    const lh = (lw * logo.height) / logo.width;
    p.image(MARGIN, headerTop - lh, lw, lh);
  } else {
    p.text(MARGIN, headerTop - 18, "PES SUPPLY", { size: 18, bold: true, color: ACCENT });
    p.text(MARGIN, headerTop - 32, "Portlandia Electric Supply", { size: 9, color: MUTE });
  }
  p.textRight(PAGE_W - MARGIN, headerTop - 14, "QUOTE", { size: 22, bold: true, color: ACCENT });
  p.textRight(PAGE_W - MARGIN, headerTop - 30, quote.quote_no || "", { size: 11, bold: true });
  y = headerTop - 48;
  p.textRight(PAGE_W - MARGIN, y, "portlandiaelectric.supply", { size: 8, color: MUTE });
  y -= 6;
  p.rule(MARGIN, y, PAGE_W - MARGIN, { width: 2 });
  y -= 18;

  /* ---- meta + customer block ---- */
  const metaX = MARGIN;
  const custX = MARGIN + CONTENT_W * 0.52;
  p.text(metaX, y, "Quote number", { size: 8, color: MUTE });
  p.text(metaX, y - 11, quote.quote_no || "", { size: 10, bold: true });
  p.text(metaX, y - 26, "Created on", { size: 8, color: MUTE });
  p.text(metaX, y - 37, dateLong((quote.created || "").slice(0, 10)) || "-", { size: 10 });
  p.text(metaX, y - 52, "Quote valid until", { size: 8, color: MUTE });
  p.text(metaX, y - 63, dateLong(quote.expiry) + ", 11:59 p.m. PT", { size: 10, bold: true });
  if (quote.expired) {
    p.text(metaX, y - 76, "THIS QUOTE HAS EXPIRED - prices are no longer held.", { size: 8, bold: true, color: [0.7, 0.1, 0.1] });
  }

  p.text(custX, y, "Prepared for", { size: 8, color: MUTE });
  let cy = y - 11;
  if (partner && partner.name) { p.text(custX, cy, partner.name, { size: 10, bold: true }); cy -= 12; }
  if (partner && partner.email) { p.text(custX, cy, partner.email, { size: 9 }); cy -= 11; }
  if (partner && partner.phone) { p.text(custX, cy, partner.phone, { size: 9 }); cy -= 11; }
  const addr = partner && partner.address;
  if (addr) { p.text(custX, cy, addr, { size: 9 }); cy -= 11; }
  cy -= 2;
  p.text(custX, cy, "Job / quote name", { size: 8, color: MUTE }); cy -= 11;
  p.text(custX, cy, quote.name || "", { size: 10, bold: true });

  y -= 92;

  /* ---- line table ---- */
  // Column layout per mode (x offsets relative to MARGIN).
  const cols = showSavings
    ? { item: 0, qty: 300, unit: 352, save: 420, total: CONTENT_W }
    : showPrices
      ? { item: 0, qty: 330, unit: 400, total: CONTENT_W }
      : { item: 0, qty: CONTENT_W };

  const tableHeader = () => {
    p.fillRect(MARGIN, y - 14, CONTENT_W, 18, [0.94, 0.97, 0.95]);
    p.text(MARGIN + 4, y - 10, "Item", { size: 8, bold: true });
    p.textRight(MARGIN + cols.qty + 40, y - 10, "Qty", { size: 8, bold: true });
    if (showPrices) p.textRight(MARGIN + cols.unit + 60, y - 10, "Unit price", { size: 8, bold: true });
    if (showSavings) p.textRight(MARGIN + cols.save + 44, y - 10, "You save", { size: 8, bold: true });
    if (showPrices) p.textRight(MARGIN + cols.total, y - 10, "Line total", { size: 8, bold: true });
    y -= 22;
  };
  tableHeader();

  const lines = quote.lines || [];
  if (!lines.length) {
    p.text(MARGIN + 4, y - 10, "No items on this quote.", { size: 9, color: MUTE });
    y -= 22;
  }
  for (const l of lines) {
    const titleLines = wrap(l.title || "", 9, showPrices ? 270 : 380);
    const skuLine = l.sku ? "SKU " + l.sku : "";
    const rowH = Math.max(15, titleLines.length * 11 + (skuLine ? 10 : 0) + 6);
    ensure(rowH + 10);
    if (pages[pages.length - 1] !== p && y === PAGE_H - MARGIN) tableHeader();
    let ty = y - 10;
    for (const tl of titleLines) { p.text(MARGIN + 4, ty, tl, { size: 9 }); ty -= 11; }
    if (skuLine) { p.text(MARGIN + 4, ty, skuLine, { size: 7.5, color: MUTE }); }
    const midY = y - 10;
    p.textRight(MARGIN + cols.qty + 40, midY, String(l.qty), { size: 9 });
    if (showPrices) {
      const unit = mode === "price_only" && l.list_price != null ? l.list_price : l.unit_price;
      p.textRight(MARGIN + cols.unit + 60, midY, money(unit), { size: 9 });
      if (showSavings) {
        const saveTxt = l.savings_pct != null ? "Save " + l.savings_pct + "%" : "-";
        p.textRight(MARGIN + cols.save + 44, midY, saveTxt, { size: 8, color: l.savings_pct != null ? ACCENT : MUTE, bold: l.savings_pct != null });
      }
      const lt = mode === "price_only" && l.list_price != null ? l.list_price * l.qty : l.line_total;
      p.textRight(MARGIN + cols.total, midY, money(lt), { size: 9, bold: true });
    }
    y -= rowH;
    p.rule(MARGIN, y + 4, PAGE_W - MARGIN, { width: 0.5, color: [0.88, 0.88, 0.88] });
  }

  /* ---- totals ---- */
  if (showPrices) {
    y -= 8;
    ensure(70);
    const tx = PAGE_W - MARGIN;
    if (mode === "full") {
      const listTotal = lines.reduce((s, l) => s + (l.list_price != null ? l.list_price : l.unit_price) * l.qty, 0);
      const savings = listTotal - quote.total;
      p.textRight(tx - 150, y, "Item subtotal", { size: 9, color: MUTE });
      p.textRight(tx, y, money(listTotal), { size: 9 });
      y -= 14;
      if (savings > 0.004) {
        p.textRight(tx - 150, y, "Estimated quote savings", { size: 9, bold: true, color: ACCENT });
        p.textRight(tx, y, "-" + money(savings), { size: 9, bold: true, color: ACCENT });
        y -= 14;
      }
    }
    p.textRight(tx - 150, y, "Delivery fees & taxes", { size: 9, color: MUTE });
    p.textRight(tx, y, "Calculated at checkout", { size: 8, color: MUTE });
    y -= 8;
    p.rule(tx - 170, y, tx, { width: 1, color: [0.8, 0.8, 0.8] });
    y -= 14;
    const grand = mode === "price_only"
      ? lines.reduce((s, l) => s + (l.list_price != null ? l.list_price : l.unit_price) * l.qty, 0)
      : quote.total;
    p.textRight(tx - 150, y, "Estimated total", { size: 12, bold: true });
    p.textRight(tx, y, money(grand), { size: 12, bold: true });
    y -= 24;
  }

  /* ---- legal blocks (kept together; new page only if they don't fit) ---- */
  const legalHeight = 24 + LEGAL_BLOCKS.reduce(
    (h, b) => h + 9 + wrap(b.body, 7.5, CONTENT_W).length * 9 + 6, 0
  );
  if (y - legalHeight < MARGIN + 30) newPage();
  y -= 6;
  p.rule(MARGIN, y, PAGE_W - MARGIN, { width: 1, color: [0.8, 0.8, 0.8] });
  y -= 12;
  p.text(MARGIN, y, "QUOTE TERMS", { size: 8, bold: true, color: MUTE });
  y -= 12;
  for (const block of LEGAL_BLOCKS) {
    const body = block.body.replace("{expiry}", dateLong(quote.expiry) || "the date shown above");
    ensure(50);
    p.text(MARGIN, y, block.title, { size: 7.5, bold: true });
    y -= 9;
    for (const ln of wrap(body, 7.5, CONTENT_W)) {
      p.text(MARGIN, y, ln, { size: 7.5, color: MUTE });
      y -= 9;
    }
    y -= 6;
  }

  /* ---- footer ---- */
  y = Math.max(y, MARGIN + 14);
  const footerText = quote.footer ||
    "Prices held until " + dateLong(quote.expiry) + " on eligible items. Availability confirmed at order time.";
  p.text(MARGIN, MARGIN + 6, footerText, { size: 8, color: MUTE });
  p.textRight(PAGE_W - MARGIN, MARGIN + 6, "PES Supply - portlandiaelectric.supply", { size: 8, color: MUTE });

  pages.push(p);
  return pages;
}

/* ---------------- PDF assembly ---------------- */

function assemblePdf(pageStreams, logo) {
  const objects = []; // {num, body: Buffer}
  // Reserve object numbers 1 (catalog) and 2 (page tree) up front.
  objects.push({ num: 1, body: Buffer.alloc(0) }, { num: 2, body: Buffer.alloc(0) });
  const addObj = (body) => {
    objects.push({ num: objects.length + 1, body: Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1") });
    return objects.length;
  };

  const catalogNum = 1;
  const pagesNum = 2;
  const font1Num = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const font2Num = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  let logoNum = null;
  if (logo) {
    logoNum = addObj(Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.data.length} >>\nstream\n`,
        "latin1"),
      logo.data,
      Buffer.from("\nendstream", "latin1"),
    ]));
  }

  const pageNums = [];
  const contentNums = [];
  for (const stream of pageStreams) {
    const contentNum = addObj(Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
      stream,
      Buffer.from("\nendstream", "latin1"),
    ]));
    contentNums.push(contentNum);
    const xobj = logoNum ? ` /XObject << /Im1 ${logoNum} 0 R >>` : "";
    const pageNum = addObj(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${font1Num} 0 R /F2 ${font2Num} 0 R >>${xobj} >> ` +
      `/Contents ${contentNum} 0 R >>`
    );
    pageNums.push(pageNum);
  }

  // Objects 1 (catalog) and 2 (pages) were reserved first.
  objects[catalogNum - 1] = { num: catalogNum, body: Buffer.from(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`, "latin1") };
  objects[pagesNum - 1] = {
    num: pagesNum,
    body: Buffer.from(`<< /Type /Pages /Kids [${pageNums.map((n) => n + " 0 R").join(" ")}] /Count ${pageNums.length} >>`, "latin1"),
  };

  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let pos = chunks[0].length;
  for (const obj of objects) {
    offsets[obj.num] = pos;
    const head = Buffer.from(`${obj.num} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, obj.body, tail);
    pos += head.length + obj.body.length + tail.length;
  }
  const xrefPos = pos;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  const trailer = `trailer\n<< /Size ${count} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, "latin1"));
  return Buffer.concat(chunks);
}

/**
 * renderQuotePdf({quote, partner, mode}) -> Buffer (application/pdf).
 * Pure: no I/O beyond the (cached, optional) logo asset read.
 */
let cachedLogo;
function renderQuotePdf({ quote, partner, mode }) {
  if (!["full", "price_only", "none"].includes(mode)) throw new Error(`unknown pdf mode: ${mode}`);
  if (cachedLogo === undefined) cachedLogo = loadLogo();
  const pages = buildPages(quote, partner || {}, mode, cachedLogo);
  return assemblePdf(pages.map((pg) => pg.stream()), cachedLogo);
}

module.exports = { renderQuotePdf, LEGAL_BLOCKS, _internals: { sanitize, wrap, money, dateLong } };
