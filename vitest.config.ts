import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/setu_vendor_portal_test",
      DIRECT_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/setu_vendor_portal_test",
      ALLOWED_SHOPS: "seller-panel-dev.myshopify.com",
      PORTAL_SHOP: "seller-panel-dev.myshopify.com",
      // Store listing updates need a Shopify session; tests/listing.db.test.ts switches them on with a fake.
      STORE_LISTING_SYNC: "off",
    },
  },
});
