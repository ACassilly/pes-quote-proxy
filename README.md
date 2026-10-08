# PES Quote Proxy — app-proxy backend (P0+P1+Wave-1)

Axis (Odoo 19) XML-RPC backend for the Lowe's-style quote program. Zero npm
dependencies — Node >= 18 stdlib only.

## Run

```bash
node server.js          # listens on http://localhost:8787 (PORT to override)
```

Container deploy (Azure Container Instances): `node scripts/boot.mjs` seeds
the SKU→variant map from the public storefront `/products.json` pages, then
starts the server.

Credentials resolve in this order (never printed, never written to disk):

1. `ODOO_API_KEY` env var, or
2. Azure Key Vault at runtime via the authenticated `az` CLI:
   vault `kv-riven-ops-eus`, secret `Riven-ERP-Api-Password` (user `admin`).

Optional env: `ODOO_URL` (default `https://axis.pesdistribution.com`),
`ODOO_DB` (default `riven_erp_pes`), `ODOO_USER` (default `admin`),
`QUOTE_VALIDITY_DAYS` (default `7`), `DRIFT_REVIEW_PCT` (default `0.03`),
`VOLUME_THRESHOLD` (default `2000` — display-only progress bar; discount
itself stays an Axis pricelist decision, bar hidden on contract-priced quotes),
`SHOPIFY_APP_SECRET` (enables app-proxy HMAC verification — REQUIRED in
production; unset = local dev mode with a logged warning),
`RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SEC` (per-IP token bucket, defaults 60/1),
`PREVIEW_TTL_MINUTES` (Wave-1 preview-token TTL, default 15),
`RESEND_API_KEY` (Wave-1 mail rail — UNSET means lifecycle emails are composed
and queued to `data/email-outbox.json` but NOTHING is sent),
`MAIL_FROM`, `STOREFRONT_URL`, `EXPIRY_SWEEP_ENABLED` (default on; 12h
in-process day-5-of-7 expiring-quote sweep),
`QUOTE_FLAG_MIN` (Wave-2B flag threshold, default `10000`; legacy
`QUOTE_APPROVAL_MIN` honored; `<=0` disables flagging — owner ruling
2026-10-08: over-threshold quotes are FLAGGED for staff attention, NEVER
blocked), `QUOTE_FLAG_EMAIL` (staff notification mailbox, legacy
`QUOTE_APPROVER_EMAIL` honored, default `sales@portlandiaelectric.supply`),
`INTERCOM_TOKEN` + `INTERCOM_ADMIN_ID` (Wave-2B Intercom rail — **LIVE since
2026-10-08**: token in KV `intercom-access-token`, set as ACI secure env;
admin id 11175212 = alex@pes.supply. UNSET means flag notes compose to
`data/intercom-outbox.json` and NOTHING is posted),
`ORDER_SYNC_ENABLED`, `ORDER_SYNC_ADMIN_TOKEN` (Stitch-2 Shopify→Axis order
sync; loop off and admin routes 404 unless set).

## Endpoints (mounted under `/proxy/quotes` — app proxy maps `/apps/quotes/*` here)

| Method & path | Body | What it does |
|---|---|---|
| `GET /healthz` | — | liveness + SKU-map stats + `dev_mode` + `mail_rail` + `order_sync` |
| `POST /proxy/quotes` | `{email, name, display_name?, customer_id?, line?{sku,qty}}` | resolve/create partner by email; idempotent draft `sale.order` create (`client_order_ref`=name, `validity_date`=today+7) |
| `GET /proxy/quotes?email=…` | — | list active quotes (drawer) |
| `GET /proxy/quotes/:ref?email=…` | — | quote detail with lines: per-line `list_price` + `savings_pct`, `volume_progress` block, `contract_priced` flag |
| `POST /proxy/quotes/:ref/rename` | `{email, name}` | rename (updates `client_order_ref`) |
| `POST /proxy/quotes/:ref/lines` | `{email, action: add\|update\|remove, sku?, qty?, line_id?}` | idempotent line write (update-in-place, `pesq:` key in line name); any edit re-states validity to today+7 |
| `POST /proxy/quotes/:ref/convert` | `{email}` | cart permalink `/cart/{variant}:{qty},…` + price-drift payload (`requires_review` when any line drifts > +3%) |
| `POST /proxy/quotes/:ref/expire-refresh` | `{email}` | re-quote: validity restated to today+7 |
| `POST /proxy/quotes/:ref/delete` | `{email, confirm:true}` | **P1** — permanent delete (Axis `unlink`, fallback `cancel`); cannot undo; share + preview tokens purged |
| `POST /proxy/quotes/:ref/share` | `{email, mode: full\|price_only\|none, note?}` | **P1** — create/regenerate a share link; regenerating revokes prior tokens for the quote |
| `POST /proxy/quotes/:ref/share/revoke` | `{email, token?}` | **P1** — revoke one token, or all for the quote when `token` omitted |
| `GET /proxy/quotes/shared/:token` | — | **P1** — token-gated masked view. NO email required: the unguessable token is the capability. Mode `none` responses contain no price fields at all. **Wave-1:** also resolves 15-min preview tokens (payload `preview:true`) |
| `GET /proxy/quotes/sku-search?q=…` | — | **Wave-1** — SKU/name typeahead for quote-detail Quick Add (prefix > substring > title, ≤8 rows) |
| `POST /proxy/quotes/:ref/lines/bulk` | `{email, text\|lines, confirm}` | **Wave-1 (P2-10)** — bulk paste/CSV quick-add. `confirm` falsy = preview (parse + SKU-map resolve, ZERO writes, per-line failure reasons); `confirm:true` = one idempotent batch commit against Axis (existing products updated in place, never duplicated); failures always listed, never silently dropped |
| `POST /proxy/quotes/:ref/copy` | `{email}` | **Wave-1** — Make a Copy: new quote #, fresh 7-day validity, carries ALL lines + PO/Job name (`<name> (Copy)`) + notes + pricelist; idempotent (reuses a still-draft copy) |
| `POST /proxy/quotes/:ref/preview` | `{email, mode, note?}` | **Wave-1 (P2-9)** — Preview as client: ephemeral 15-min token for the exact recipient view. Separate store (`data/preview-tokens.json`); never creates, revokes, or pollutes real share links |
| `GET /proxy/quotes/:ref/pdf?email=…&mode=…` | — | **Wave-1 (P2-3)** — PES-branded quote PDF; `mode=full\|price_only\|none` mirrors the share masking modes |
| `GET /proxy/quotes/shared/:token/pdf` | — | **Wave-1** — shared-link PDF masked per the token's stored mode (`none` => zero prices/totals); preview tokens resolve too |
| `POST /proxy/quotes/ops/sweep` | — | **Wave-1** — manual run of the day-5-of-7 expiring-quote email sweep (registry-guardrailed, deduped; outbox-only while the mail rail is stubbed) |
| `GET /proxy/quotes/reorder/history?email=…&q=…` | — | **Wave-2A (P2-11)** — past converted quotes + Shopify/Axis order history, searchable by quote name / PO / job name / order #. **Trust note:** identity is the email address, exactly the same model as `GET /proxy/quotes?email=` — requests arrive through the HMAC-verified app proxy; no additional secret is assumed |
| `POST /proxy/quotes/reorder` | `{email, source:{type: quote\|order, ref}}` | **Wave-2A (P2-11)** — job-scoped reorder. Every source line still in the catalog ⇒ NEW draft quote at the **original** unit prices (price memory; `price_unit` pinned deliberately, unlike normal quote lines). Any item changed ⇒ current-price cart permalink + visible `prices_updated` notice, missing items listed — never a silent reprice. Idempotent (`"<job> (Reorder)"` draft reused, lines update-in-place). Reorder from a Shopify order verifies the order's email matches the request identity |
| `POST /proxy/quotes/from-cart` | `{email, name, lines:[{sku,qty}]}` | **Wave-2A (P2-5)** — Save Cart as Quote, **COPY semantics**: the cart is never emptied (`cart_unchanged: true` + notice). **Trust note:** the client passes the cart's lines, but only `sku` + `qty` are accepted — any client-supplied price field is dropped by the parser; prices are computed server-side by Axis pricelists at quote time. Unknown SKUs fail loud, listed with reasons |

A successful `POST /proxy/quotes/:ref/convert` also marks the quote as a past
converted quote (proxy registry) — that is what the reorder history lists.
| `GET /proxy/quotes/approve?token=…` | — | **Wave-2B — RETIRED** (owner ruling 2026-10-08: flag, never block). Returns **410 Gone** with a clear "quotes are never blocked" page; the single-use approve-token machinery was dropped |
| `GET /proxy/quotes/aliases?email=…` | — | **Wave-2B (#109)** — list the customer's part-number aliases |
| `POST /proxy/quotes/aliases` | `{email, customer_sku, our_sku}` | **Wave-2B (#109)** — add/overwrite an alias (`our_sku` validated against the catalog map) |
| `POST /proxy/quotes/aliases/remove` | `{email, customer_sku}` | **Wave-2B (#109)** — remove an alias |

**Wave-2B behaviors (owner ruling 2026-10-08 — FLAG, never block):**
conversion is NEVER gated; quotes of any size convert freely. When a quote's
total reaches `QUOTE_FLAG_MIN` it is flagged for staff attention on three
surfaces: **Axis** (`crm.tag` `pes_flag_review` + a `mail.activity` To-Do with
quote #/total/threshold/timestamp and "conversion NOT blocked"), **Intercom**
(`intercom.js` — full composer + client, STUBBED behind `INTERCOM_TOKEN`
exactly like the mail outbox; no token exists yet), and the **sales channel**
(convert permalink carries `attributes[pes-flag]=quote-review-needed` +
`attributes[pes-quote-no]=S…` cart attributes, which land as Shopify order
note_attributes and are carried into the Axis order note by order-sync). A
staff notification email composes to the stubbed outbox rail (`quote_flagged`
event, notification wording — NO approve link). The flag store is
`data/quote-approvals.json` (container-fs; losing it only loses the audit
trail, never a customer capability). Bulk quick-add resolves customer part
numbers from the alias store FIRST, then the catalog SKU map; matched lines
are flagged `via_alias` and quote detail + PDF show the customer's part number
alongside our SKU.

Error model: 4xx with `{error}` for client mistakes; 502 with
`{error, degraded: true}` when Axis is unreachable (drawer renders the
"live pricing temporarily unavailable" state).

## Files

- `server.js` — HTTP routes, app-proxy HMAC verification, per-IP rate limiting
- `axis.js` / `xmlrpc.js` — zero-dep XML-RPC client; calls logged (secrets never logged)
- `quotes.js` — quote service (field contract, idempotency, drift policy, delete, share, **Wave-1:** bulkAddLines, copyQuote, previewQuote, PDF, expiring sweep)
- `share.js` — **P1** share tokens + 3-mode price masking (`maskQuote` is pure/unit-tested)
- `preview.js` — **Wave-1** ephemeral preview tokens (separate store, 15-min TTL, purge on delete)
- `bulk.js` — **Wave-1** paste/CSV parse + resolve (pure, unit-tested)
- `reorder.js` — **Wave-2A** job-scoped reorder (history, honored-price rebuild, cart fallback) + Save-Cart-as-Quote (copy semantics); pure helpers unit-tested in `scripts/test-w2a-units.js`
- `pdf.js` — **Wave-1** PES-branded quote PDF (zero-dep writer; logo from `assets/pes-logo.b64`, text-wordmark fallback)
- `mailer.js` — **Wave-1** lifecycle emails (created/shared/expiring/converted + **Wave-2B** `quote_flagged` staff notification); rail STUBBED without `RESEND_API_KEY`
- `approval.js` — **Wave-2B (P2-12, owner ruling 2026-10-08)** flag store for over-threshold quotes (never blocks conversion; approve-token machinery dropped)
- `intercom.js` — **Wave-2B** Intercom staff-flag rail (composer + client, STUBBED without `INTERCOM_TOKEN`)
- `aliases.js` — **Wave-2B (#109)** customer part-number alias store (customer_email + customer_sku → our_sku)
- `order-sync.js` / `registry.js` — Stitch-2 order sync + proxy-touched-quote registry
- `progress.js` — **P1** volume progress + public-pricelist detection (non-stacking rule)
- `cache.js` — customer-metafield cache writer **(STUB: local JSON until Admin creds land)**
- `sku-map.js` + `data/sku-variant-map.json` — SKU→variant mapping (boot-seeded from the public storefront feed)
- `data/share-tokens.json`, `data/preview-tokens.json`, `data/email-outbox.json`, `data/known-quotes.json` — runtime stores; **persist across deploys** or links die
- `data/quote-approvals.json`, `data/customer-aliases.json` — **Wave-2B** runtime stores, same container-fs persistence model: LOST on container group recreation. Losing approvals fails safe (over-threshold quotes flip back to pending); losing aliases means customers re-enter their part numbers (recreation caveat — Azure Files mount for `data/` still pending storage perms)
- `scripts/axis-test-cycle.js` / `axis-test-p1.js` / `axis-test-w1.js` — live-Axis validation cycles (create→verify→DELETE)
- `scripts/test-p1-units.js` / `test-w1-units.js` / `test-wave1-comms.js` — unit tests, no Axis

## Validation

```bash
node scripts/test-p1-units.js     # P1 units (16 checks, no Axis)
node scripts/test-w1-units.js     # Wave-1 units (18 checks, no Axis)
node scripts/test-wave1-comms.js  # Wave-1 comms units (86 checks, no Axis)
node scripts/test-w2a-units.js    # Wave-2A units (reorder price logic, copy semantics, trust path)
node scripts/test-w2b-units.js    # Wave-2B units (flag semantics, alias order, permalink attrs)
node scripts/axis-test-cycle.js   # P0 live cycle
node scripts/axis-test-p1.js      # P1 live cycle
node scripts/axis-test-w1.js      # Wave-1 live cycle (typeahead/bulk/copy/preview/delete)
node scripts/axis-test-w2a.js     # Wave-2A live cycle (reorder honored pricing + save-cart, signed requests)
node scripts/axis-test-w2b2.js    # Wave-2B live cycle (flag-not-block + aliases; supersedes axis-test-w2b.js)
```
