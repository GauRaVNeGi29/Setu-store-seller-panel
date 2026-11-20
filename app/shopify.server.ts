import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { assertAllowedShop } from "./lib/guard.server";
import { fullSync } from "./lib/orders/sync.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // Custom app for Setu Store only. During development: the dev store only.
  distribution: AppDistribution.SingleMerchant,
  hooks: {
    afterAuth: async ({ session, admin }) => {
      assertAllowedShop(session.shop);
      // First install: copy the order history in the background.
      const state = await prisma.syncState.findUnique({ where: { shop: session.shop } });
      if (!state?.lastFullSyncAt) {
        void fullSync(prisma, admin.graphql, session.shop, "backfill").catch((e) =>
          console.error(`[vendor-portal] first order sync failed for ${session.shop}`, e),
        );
      }
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
