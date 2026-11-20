import { describe, expect, it } from "vitest";
import { assertAllowedShop, isAllowedShop, LIVE_STORE } from "../app/lib/guard.server";

const env = { ALLOWED_SHOPS: "seller-panel-dev.myshopify.com" };

describe("store guard", () => {
  it("allows the dev store", () => {
    expect(isAllowedShop("seller-panel-dev.myshopify.com", env)).toBe(true);
    expect(isAllowedShop("  SELLER-PANEL-DEV.myshopify.com ", env)).toBe(true);
  });

  it("refuses the live store and anything unlisted", () => {
    expect(isAllowedShop(LIVE_STORE, env)).toBe(false);
    expect(isAllowedShop("other.myshopify.com", env)).toBe(false);
    expect(() => assertAllowedShop(LIVE_STORE, env)).toThrow();
  });

  it("refuses everything when ALLOWED_SHOPS is missing", () => {
    expect(isAllowedShop("seller-panel-dev.myshopify.com", {})).toBe(false);
  });
});

import { showDevCodeOnPage } from "../app/lib/portal/email.server";

describe("dev code on the login page", () => {
  it("only when explicitly enabled, outside production, without an email provider", () => {
    expect(showDevCodeOnPage({ PORTAL_DEV_SHOW_CODE: "true", NODE_ENV: "development" })).toBe(true);
    expect(showDevCodeOnPage({ PORTAL_DEV_SHOW_CODE: "true", NODE_ENV: "production" })).toBe(false);
    expect(showDevCodeOnPage({ NODE_ENV: "development" })).toBe(false);
    expect(showDevCodeOnPage({ PORTAL_DEV_SHOW_CODE: "true", NODE_ENV: "development", RESEND_API_KEY: "k", PORTAL_EMAIL_FROM: "a@b.c" })).toBe(false);
  });
});
