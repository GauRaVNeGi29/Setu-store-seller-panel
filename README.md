# Setu Vendor Portal

Custom Shopify app that will give Setu Store's vendors a secure place to see their own orders, shipments and earnings, replacing the vendor side of Webkul step by step.

**Status: Stage 1 – development only.** No vendor login yet. The app copies every order line into its own database, filed by vendor, and shows the team a vendor overview inside Shopify admin so the data can be checked against Shopify.

## Safety rules

- Development uses **only** the dev store `seller-panel-dev.myshopify.com`.
- The app refuses any shop not listed in `ALLOWED_SHOPS` (see `app/lib/guard.server.ts`). The live store `q0zr1f-0m.myshopify.com` is never listed during development.
- Read-only Shopify access: `read_orders, read_products, read_metaobjects, read_merchant_managed_fulfillment_orders`. No theme or write scopes.
- Never run `shopify app config link` or `deploy` against the live store until a production stage is explicitly approved.

## What Stage 1 contains

| Part | File |
| --- | --- |
| Order → vendor lines (pure logic) | `app/lib/orders/map.ts` |
| Re-read orders from Shopify, save, full resync | `app/lib/orders/sync.server.ts` |
| Webhook burst queue | `app/lib/orders/queue.server.ts` |
| Order webhooks (create, update, cancel, fulfil, refund, delete) | `app/routes/webhooks.orders.tsx` |
| Team screens: vendor overview, one vendor's lines | `app/routes/app._index.tsx`, `app/routes/app.vendor.tsx` |
| Store guard | `app/lib/guard.server.ts` |
| Database | `prisma/schema.prisma` (VendorOrderLine, SyncState, AuditLog) |
| Tests (21) built from the dev store's test orders #1001–#1005 | `tests/` |

## First-time setup on your PC

1. **Create the dev app.** Dev Dashboard (dev.shopify.com) → Apps → Create app → name it **Setu Vendor Portal – DEV**.
2. **Allow order data.** In that app: API access → Protected customer data access → select *Protected customer data* and give a reason (e.g. "Show vendors their own orders"). Without this, Shopify refuses order webhooks and order reads. Stage 1 does not request customer name/address fields.
3. **Install and link.**
   ```bash
   git clone https://github.com/GauRaVNeGi29/Setu-store-seller-panel.git
   cd Setu-store-seller-panel
   npm install
   npm run config:link      # choose "Setu Vendor Portal – DEV"; this fills client_id in shopify.app.toml
   ```
4. **Local database.** Any Postgres works. Easiest: a free Neon project named `setu-vendor-portal-dev` (separate from the Import Duties database). Copy `.env.example` to `.env` and set `DATABASE_URL` and `ALLOWED_SHOPS=seller-panel-dev.myshopify.com`.
5. **Run.**
   ```bash
   npm run dev              # shopify app dev; pick seller-panel-dev.myshopify.com when asked
   ```
   Open the app from the dev store admin. On first open it copies all orders; the **Vendors and orders** page should show:

   | Vendor | Orders | Units sold | Gross | Refunded | Net | Units to ship |
   | --- | --- | --- | --- | --- | --- | --- |
   | Ashnur | 3 | 10 | ₹1,875 | ₹0 | ₹1,875 | 10 |
   | Urban Store | 5 | 51 | ₹3,550 | ₹75 | ₹3,475 | 33 |

6. **Check live updates.** In the dev store, fulfil the Ashnur candle on #1004. Within a few seconds Ashnur's "Units to ship" drops from 10 to 7.

## Tests

```bash
# needs a throwaway Postgres database
export TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/setu_vendor_portal_test
DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy
npm test
```

CI (`.github/workflows/ci.yml`) runs type check, lint, tests against a temporary Postgres, and build on every push.

## Money rules (Stage 1)

- **Gross** = line total after discounts, before refunds. Cancelled orders add nothing.
- **Net** = gross − refunded line amounts.
- Shipping, taxes and order-level adjustments are not yet split by vendor; commission rules arrive in Stage 5.
