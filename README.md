# PES Quote Proxy — app-proxy backend (P0+P1)

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
production; unset = local dev mode with a logged warning).

## Endpoints (mounted under `/proxy/quotes` — app proxy maps `/apps/quotes/*` here)

| Method & path | Body | What it does |
|---|---|---|
| `GET /healthz` | — | liveness + SKU-map stats |
| `POST /proxy/quotes` | `{email, name, display_name?, customer_id?, line?{sku,qty}}` | resolve/create partner by email; idempotent draft `sale.order` create (`client_order_ref`=name, `validity_date`=today+7) |
| `GET /proxy/quotes?email=…` | — | list active quotes (drawer) |
| `GET /proxy/quotes/:ref?email=…` | — | quote detail with lines: per-line `list_price` + `savings_pct`, `volume_progress` block, `contract_priced` flag |
| `POST /proxy/quotes/:ref/rename` | `{email, name}` | rename (updates `client_order_ref`) |
| `POST /proxy/quotes/:ref/lines` | `{email, action: add\|update\|remove, sku?, qty?, line_id?}` | idempotent line write (update-in-place, `pesq:` key in line name); any edit re-states validity to today+7 |
| `POST /proxy/quotes/:ref/convert` | `{email}` | cart permalink `/cart/{variant}:{qty},…` + price-drift payload (`requires_review` when any line drifts > +3%) |
| `POST /proxy/quotes/:ref/expire-refresh` | `{email}` | re-quote: validity restated to today+7 |
| `POST /proxy/quotes/:ref/delete` | `{email, confirm:true}` | **P1** — permanent delete (Axis `unlink`, fallback `cancel`); cannot undo; share tokens purged |
| `POST /proxy/quotes/:ref/share` | `{email, mode: full\|price_only\|none, note?}` | **P1** — create/regenerate a share link; regenerating revokes prior tokens for the quote |
| `POST /proxy/quotes/:ref/share/revoke` | `{email, token?}` | **P1** — revoke one token, or all for the quote when `token` omitted |
| `GET /proxy/quotes/shared/:token` | — | **P1** — token-gated masked view. NO email required: the unguessable token is the capability. Mode `none` responses contain no price fields at all. |

Error model: 4xx with `{error}` for client mistakes; 502 with
`{error, degraded: true}` when Axis is unreachable (drawer renders the
"live pricing temporarily unavailable" state).
