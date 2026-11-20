# Setu Vendor Portal

Custom Shopify app that will give Setu Store's vendors a secure place to see their own orders, shipments and earnings, replacing the vendor side of Webkul step by step.

**Status: Stages 1–4 – development only (dev store).**

- **Stage 1:** the app copies every order line into its own database, filed by vendor, kept current by order webhooks.
- **Stage 2:** the team sets up vendors and invites the emails allowed in (Shopify admin → the app → a vendor → *Vendor portal access*), and approves self sign-ups (*Sign-ups* page).
- **Stage 3:** vendors create an account at `/portal/signup` and sign in with email + password at `/portal/login`; *Forgot password* emails a reset link. Invited emails get in straight away; anyone else waits for approval.
- **Stage 4:** vendors see *My orders*, each order's detail (their items only), *What to ship* and *My brand*.

## Safety rules

- Development uses **only** the dev store `seller-panel-dev.myshopify.com`.
- The app refuses any shop not listed in `ALLOWED_SHOPS` (see `app/lib/guard.server.ts`). The live store `q0zr1f-0m.myshopify.com` is never listed during development.
- Read-only Shopify access: `read_orders, read_products, read_metaobjects, read_merchant_managed_fulfillment_orders`. No theme or write scopes.
- Never run `shopify app config link` or `deploy` against the live store until a production stage is explicitly approved.

## What the app contains

| Part | File |
| --- | --- |
| Order → vendor lines (pure logic) | `app/lib/orders/map.ts` |
| Re-read orders from Shopify, save, full resync | `app/lib/orders/sync.server.ts` |
| Webhook burst queue | `app/lib/orders/queue.server.ts` |
| Order webhooks (create, update, cancel, fulfil, refund, delete) | `app/routes/webhooks.orders.tsx` |
| Team screens: vendor overview, one vendor's lines | `app/routes/app._index.tsx`, `app/routes/app.vendor.tsx` |
| Store guard | `app/lib/guard.server.ts` |
| Database | `prisma/schema.prisma` (VendorOrderLine, SyncState, AuditLog) |
| Vendor records and access (team) | `app/lib/vendors/vendors.server.ts`, `app/routes/app.vendor.tsx` |
| Sign-up, sign-in, password reset, sessions | `app/lib/portal/auth.server.ts`, `app/routes/portal_.*.tsx` |
| Sign-up approval (team) | `app/routes/app.signups.tsx` |
| Vendor portal pages | `app/routes/portal*.tsx`, `app/lib/portal/data.server.ts` |
| Tests (76): order mapping, sync, passwords, sign-up, approval, reset, sessions, vendor isolation through the real pages | `tests/` |

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

## Trying the vendor portal (dev store)

1. In `.env`: `PORTAL_SHOP=seller-panel-dev.myshopify.com` and `PORTAL_DEV_SHOW_EMAILS=true` (shows the would-be reset email on the page, since no email service is set up yet).
2. `npm run dev`, open the app in the dev store admin.
3. **Invited vendor:** click a vendor (e.g. Ashnur) → *Set up portal access* → add an email. Then open `<trycloudflare address>/portal/signup` in a private window, use that email, fill the form → straight into *My orders*.
4. **New vendor:** sign up with an email nobody invited → *under review*. In the app, *Sign-ups* → choose the Shopify vendor name → *Approve*. Refresh the portal → their orders appear.
5. **Forgot password:** `/portal/forgot` → the page shows the reset link (development only) → choose a new password.

What vendors never see: other vendors' items, an order's grand total, the buyer's name, email, phone or address. Applicants waiting for approval see no order data at all.

### Security rules (enforced on the server, covered by tests)

- Passwords: at least 10 characters, not all digits, not the email name; stored as scrypt hashes with a random salt.
- 5 wrong passwords lock that email for 15 minutes; 30 failures per IP per hour block the IP; 5 sign-ups per IP per hour.
- The vendor link (which Shopify vendor's orders someone sees) is set only by the team: by inviting the email, or by approving a sign-up. Nothing a vendor types can set it.
- Reset links: random token (only its hash stored), single use, 30 minutes; a reset ends every session. "Forgot password" answers the same for unknown emails.
- Sessions: random token in an `HttpOnly; Secure; SameSite=Lax` cookie, only its hash stored; end after 12 h idle, 7 days, sign-out, password reset, or when the team pauses the vendor, declines the sign-up or removes the person.
- Every portal query is filtered by the signed-in vendor from the session. Another vendor's order returns the same "not found" as an order that doesn't exist. Portal pages can't be framed and aren't cached.

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
