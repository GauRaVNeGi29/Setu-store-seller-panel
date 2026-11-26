# Setu Store Vendor Portal

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
| Store listing (vendor details, seller collections, Brands page) | `app/lib/storefront/`, `extensions/setu-vendor-details/`, `tests/storefront/` |
| Reviews (rules, seller page, team controls) | `app/lib/reviews/`, `app/routes/portal.reviews.tsx`, `app/routes/app.vendor.tsx` |
| Dashboard and store settings (delivery time) | `app/routes/app._index.tsx`, `app/lib/settings/`, `app/lib/vendors/shipping.ts` |
| Tests (76): order mapping, sync, passwords, sign-up, approval, reset, sessions, vendor isolation through the real pages | `tests/` |

## First-time setup on your PC

1. **Create the dev app.** Dev Dashboard (dev.shopify.com) → Apps → Create app → name it **Setu Store Vendor Portal – DEV**.
2. **Allow order data.** In that app: API access → Protected customer data access → select *Protected customer data* and give a reason (e.g. "Show vendors their own orders"). Without this, Shopify refuses order webhooks and order reads. Stage 1 does not request customer name/address fields.
3. **Install and link.**
   ```bash
   git clone https://github.com/GauRaVNeGi29/Setu-store-seller-panel.git
   cd Setu-store-seller-panel
   npm install
   npm run config:link      # choose "Setu Store Vendor Portal – DEV"; this fills client_id in shopify.app.toml
   ```
4. **Local database.** Any Postgres works. Easiest: a free Neon project named `setu-vendor-portal-dev` (separate from the Import Duties database). Copy `.env.example` to `.env` and set `DATABASE_URL` (Neon's pooled address), `DIRECT_URL` (the direct address, used only for migrations) and `ALLOWED_SHOPS=seller-panel-dev.myshopify.com`.
5. **Run.**
   ```bash
   npm run dev              # shopify app dev; pick seller-panel-dev.myshopify.com when asked
   ```
   Open the app from the dev store admin. On first open it copies all orders. The app opens on the **Dashboard**; the **Vendors and orders** page should show:

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

## Reviews

Buyers rate a seller from 1 to 5 stars, with an optional comment. Code: `app/lib/reviews/`.

- **Who can review:** only a buyer with a shipped, not-cancelled order from that seller. One review per buyer per seller; sending another replaces it.
- **Seller portal:** *Reviews* shows the rating, a breakdown by stars and every review. Sellers can read but not change them, and never see who the buyer is (only the name the buyer chose, and the order number).
- **Shopify app:** the vendor page lists the reviews; the team can hide one with a reason (the seller sees the reason) or show it again. Hidden reviews aren't counted. *All vendors* shows each rating.
- **Store listing:** the average and the number of reviews are copied to the seller's Marketplace seller entry (`rating`, `review_count`) for the theme.
- **Not built yet:** the storefront form where buyers leave a review. Until then, `npm run reviews:sample` adds clearly labelled sample reviews on the development store only (`npm run reviews:sample -- remove` takes them out).

## Vendor details on the storefront (product page)

The app copies each vendor's public brand details into the store's **Marketplace seller** entry
(`marketplace_seller` metaobject): brand name, short description, description, logo, banner and minimum
order value. The cart already reads the minimum from there. Business documents never leave the app.

- **When:** a seller saves *My brand*, or the team saves *Details* on the vendor page. *Update store listing*
  (vendor page) and *Update all store listings* (All vendors) run it by hand. A failed update never undoes the save;
  the reason shows on the vendor page.
- **Fields:** the app adds any missing fields to the definition (`display_name`, `short_description`,
  `description`, `logo`, `banner`). It never changes `collection` or `webkul_seller_id`, and never blanks a
  minimum the app doesn't have yet. Code: `app/lib/storefront/listing.server.ts`.
- **Theme:** the *Vendor details* theme app extension (`extensions/setu-vendor-details`) fills two placeholders,
  the same way Webkul's script fills its own:
  ```html
  <div class="setu-vendor-header"></div>        <!-- logo, name (links to the seller collection), Min ₹ -->
  <div class="setu-vendor-description"></div>   <!-- description and "Shop all from …" -->
  ```
  It also offers *Vendor header* and *Vendor description* blocks for the theme editor.

### Brands page and seller product pages

- **Seller's product page** = a collection of the seller's products, linked on the seller's Marketplace seller entry (`collection`).
  A collection already on the entry is never changed. When the entry has none, the listing update links one: an existing
  collection with the seller's handle that holds exactly the seller's products, or a new automatic collection
  ("Vendor is X"), published to the online store. Needs the `write_products` and `write_publications` scopes.
- **Seller header** on that collection page: banner, logo, name, short description, Min, rating, description. By default the
  app embed adds it at the top of the page and hides the theme's own collection title there; or place
  `<div class="setu-seller-header"></div>` yourself (setting *Seller header on a seller's collection*).
- **Brands page**: every seller with logo, name, minimum, rating and a row of products ending in "View all N products";
  sort, search and pages run in the browser. It shows on the page whose handle is set in the embed (default `brands`):
  ```html
  <div class="setu-all-brands"></div>
  ```
  With no placeholder on that page, the list adds itself at the end of the page content.
- **Seller facts** under the name: city and country (`location`), joining date (`joined_on`, the day the seller was added to
  the panel) and the number of products. The street address is never copied to the store.
- **Ratings and reviews** under the seller's product listing (added to the end of the page content, or wherever the theme
  has `<div class="setu-seller-reviews"></div>`; also the *Seller reviews* block). Left: the rating, "Brand rating (N
  reviews)" and a bar with a count for each number of stars. Right: the reviews (stars, words, date • name • the buyer's city and country, then "Purchased products:" as pictures linked to each product), a sort
  menu (Newest, Highest rated, Lowest rated; `&sort=`) and "Show more reviews". The rating in the seller header links to
  it. Reviews are fetched when the buyer scrolls near them (`setu-reviews.js`). A signed-in buyer whose order
  from the seller has shipped gets "Write a review" and a form (1–5 stars, tick boxes for the products they bought from
  the seller, comment, name to show; `setu-review-form.js`). A review can be about several products
  (`VendorReviewItem`, up to 20); their current title, picture and page come from Shopify when the reviews are shown and
  are remembered for ten minutes (`app/lib/reviews/products.server.ts`). A product with no picture, or one that is
  archived or deleted, shows as its name in words. The buyer's city and country come from the address on the order that
  lets them review (`order.displayAddress`, read by the app when the review is sent; never from the browser; never the
  street) and are kept in `VendorReview.buyerLocation`. Reading addresses needs the app's **protected customer data**
  access for the address field: development stores don't enforce it; for a live store, select it in the Dev Dashboard
  (app → Settings → Access requests → Protected customer data). Without it reviews still save, with no place shown. It talks to the app through the
  store's **app proxy** (needs the `write_app_proxy` scope): `/apps/setu-seller/reviews` → `app/routes/proxy.reviews.tsx`. Shopify signs the request and says
  which customer is signed in; the buyer's orders are read from Shopify (`orders(query: "customer_id:…")`) and matched
  against the seller's shipped order lines, so nothing about who bought what is taken from the browser. The app has to be
  running for the reviews to load; until then the section shows the rating and count the store already holds.
- **Under the seller's name, two lines:** rating · city and country · joining date · number of products, then
  `Rs. 1,000.00 minimum · Arrives Dec 10 – Dec 17`.
- **Arrival dates:** today + the seller's *processing time* + the store's *delivery time*, shown only as dates (the day
  counts themselves are not shown). Processing time is the days the seller needs to make or ready an order, a range the
  seller sets under My brand → Brand details (the team can change it on the vendor's page); it is copied to the seller's
  entry (`processing_days_min`, `processing_days_max`). Delivery time is one range for the whole store, set by the team on
  the app's **Dashboard** and kept as two app-data metafields on the app's installation
  (`setu_seller.delivery_days_min` / `_max`), which only this app can change and which Liquid reads as
  `app.metafields.setu_seller.…`. No date is shown unless both are known.
- **Brand values** on the seller page: up to five short tags the seller picks under My brand → Brand details ("Women
  owned", "Eco-friendly"; one-tap choices or their own words; the team can edit them on the vendor's page). Shown as
  pills (no visible label; the list is named "Brand values" for screen readers) under the minimum line, where the short description used to be. Kept in
  `Vendor.brandValues`, copied to the seller's entry as `brand_values` (a list). Rules: `app/lib/vendors/values.ts`.
  The short description is no longer shown on the seller page; product pages still use it.
- **Description box** on the seller page: the seller's full description in a bordered light grey box (`#f7f7f7`) across the header's width.
  It opens two lines tall with *See more*, and *See less* folds it again (`setu-about.js`). A description that fits in two
  lines gets no button; without the script the whole description shows.
- Blocks for the theme editor: *All brands* and *Seller page header*.
- Limits: 250 sellers on the Brands page; up to 12 products per seller row.
- Checks: `npm run test:storefront` renders the real snippets with LiquidJS and mock data and drives them in Chromium.

**Turning it on (dev store):**
1. `npm run dev -- --theme 189269180525` (the theme that holds the placeholders; without `--theme` the CLI uploads
   a Dawn copy to host the extension). Accept the new permissions when the app opens (store content and files).
2. In the app: *All vendors* → *Update all store listings*.
3. Online Store → Themes → Customize → App embeds → switch on **Vendor details** → Save.

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
DATABASE_URL=$TEST_DATABASE_URL DIRECT_URL=$TEST_DATABASE_URL npx prisma migrate deploy
npm test
```

CI (`.github/workflows/ci.yml`) runs type check, lint, tests against a temporary Postgres, and build on every push.

## Money rules (Stage 1)

- **Gross** = line total after discounts, before refunds. Cancelled orders add nothing.
- **Net** = gross − refunded line amounts.
- Shipping, taxes and order-level adjustments are not yet split by vendor; commission rules arrive in Stage 5.
