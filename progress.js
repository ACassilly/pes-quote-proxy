"use strict";
/*
 * progress.js — volume-pricing progress bar logic (P1, display only).
 *
 * Lowe's deep-pass finding #8: gamified gap-to-threshold on quote detail
 * ("You're $X away from … $2000.00"). Ours is DISPLAY ONLY — the actual
 * volume discount stays an Axis pricelist decision; this bar never mutates
 * pricing.
 *
 * Non-stacking rule (deep-pass #3, BINDING): contract/pricelist pricing and
 * volume discounts NEVER stack. The bar must NOT appear on quotes that carry
 * contract pricing. Detection: quote's pricelist_id !== the public pricelist
 * (resolved via ir.model.data xmlid `product.list0`, falling back to the
 * single-active-pricelist rule and then a name search — see
 * resolvePublicPricelistId). If the public pricelist cannot be resolved, the
 * bar is hidden (fail-safe: never tease a discount that may not apply).
 *
 * computeProgress() is a pure function (unit-tested without Axis).
 */

/**
 * @param {number} total        quote amount_total
 * @param {number} threshold    volume threshold (env VOLUME_THRESHOLD, default 2000)
 * @param {object} opts
 * @param {boolean|null} opts.contractPriced  true = hide bar; null = unknown -> hide (fail-safe)
 */
function computeProgress(total, threshold, { contractPriced = null } = {}) {
  const t = Number(total);
  const th = Number(threshold);
  if (!Number.isFinite(th) || th <= 0) {
    return { eligible: false, reason: "threshold_not_configured" };
  }
  if (contractPriced !== false) {
    // true => contract/pricelist pricing on the quote (non-stacking rule);
    // null => could not determine => fail-safe hide.
    return { eligible: false, reason: contractPriced ? "contract_priced" : "pricelist_unknown" };
  }
  const cur = Number.isFinite(t) ? t : 0;
  const remaining = Math.max(0, Math.round((th - cur) * 100) / 100);
  return {
    eligible: true,
    threshold: th,
    current: cur,
    remaining,
    pct: Math.min(100, Math.round((cur / th) * 1000) / 10),
    reached: cur >= th,
  };
}

/**
 * Resolve the public pricelist id. Cached per AxisClient instance.
 * Primary: ir.model.data xmlid product.list0 (Odoo standard "Public Pricelist").
 * Fallbacks, in order: (a) exactly one active pricelist => it IS the default;
 * (b) name match /public pricelist|default/i. Returns null if unresolved.
 * (Observed on Axis 2026-10-03: no product.list0 xmlid; single pricelist
 * id 2 "Default" — fallback (a) applies.)
 */
async function resolvePublicPricelistId(axis) {
  if (axis._publicPricelistId !== undefined) return axis._publicPricelistId;
  let id = null;
  try {
    const rows = await axis.searchRead(
      "ir.model.data",
      [["module", "=", "product"], ["name", "=", "list0"], ["model", "=", "product.pricelist"]],
      ["res_id"],
      { limit: 1 }
    );
    if (rows.length) id = rows[0].res_id;
  } catch (e) {
    console.warn("[progress] ir.model.data lookup failed:", e.message);
  }
  if (!id) {
    try {
      const rows = await axis.searchRead(
        "product.pricelist",
        [["active", "=", true]],
        ["id", "name"],
        { limit: 100 }
      );
      if (rows.length === 1) {
        id = rows[0].id; // single pricelist => it is the default/public one
      } else {
        const exact = rows.find((r) => /^(public pricelist|default)$/i.test(r.name || ""));
        id = (exact || {}).id || null;
      }
    } catch (e) {
      console.warn("[progress] pricelist fallback search failed:", e.message);
    }
  }
  axis._publicPricelistId = id;
  return id;
}

/**
 * Whether the quote carries contract (non-public) pricelist pricing.
 * Returns true/false, or null when the public pricelist is unknown.
 */
async function isContractPriced(axis, quotePricelistId) {
  if (!quotePricelistId) return false; // no explicit pricelist => company default flow, treat as public
  const publicId = await resolvePublicPricelistId(axis);
  if (!publicId) return null;
  return Number(quotePricelistId) !== Number(publicId);
}

module.exports = { computeProgress, resolvePublicPricelistId, isContractPriced };
