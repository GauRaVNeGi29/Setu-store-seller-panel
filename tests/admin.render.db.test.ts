import { mkdirSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";
import { fakeShopify } from "./helpers/fake-shopify";

/**
 * The team's pages inside Shopify admin, drawn from their real loaders' data:
 * each page renders without failing and shows the parts it should. Shopify's
 * sign-in and the admin frame are replaced; the pages are also written to
 * .cache/admin-preview/ as plain HTML, to look at.
 */
const who = vi.hoisted(() => ({ shop: "seller-panel-dev.myshopify.com", orders: [] as unknown[], data: null as unknown }));
vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: who.shop, onlineAccessInfo: { associated_user: { email: "team@setustore.test" } } },
      admin: { graphql: fakeShopify(who.orders as ShopifyOrder[], { metafields: new Map(), ops: [] }) },
    }),
  },
}));
vi.mock("@shopify/app-bridge-react", () => ({ useAppBridge: () => ({ toast: { show() {} } }) }));
vi.mock("react-router", async (original) => {
  const { createElement: h } = await import("react");
  const link = ({ to, children, ...rest }: { to: string; children?: ReactNode }) => h("a", { href: to, ...rest }, children);
  const form = ({ children, ...rest }: { children?: ReactNode }) => h("form", rest, children);
  return {
    ...(await original<typeof import("react-router")>()),
    useLoaderData: () => who.data,
    useFetcher: () => ({ state: "idle", data: undefined, formData: undefined, Form: form, submit() {} }),
    Link: link,
    Form: form,
  };
});

const { fullSync } = await import("../app/lib/orders/sync.server");
const { signUp } = await import("../app/lib/portal/auth.server");
const pages = {
  dashboard: await import("../app/routes/app._index"),
  vendors: await import("../app/routes/app.vendors"),
  signups: await import("../app/routes/app.signups"),
  orders: await import("../app/routes/app.orders"),
  reviews: await import("../app/routes/app.reviews"),
  mail: await import("../app/routes/app.mail"),
};

const db = new PrismaClient();
const shop = who.shop;
afterAll(() => db.$disconnect());

async function cleanup() {
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.vendorOrderLine.deleteMany({ where: { shop } });
  await db.syncState.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
  await db.shopSetting.deleteMany({ where: { shop } });
  await db.mailMessage.deleteMany({ where: { shop } });
  await db.mailTemplateSetting.deleteMany({ where: { shop } });
  await db.mailSetting.deleteMany({ where: { shop } });
}

beforeAll(async () => {
  await cleanup();
  who.orders = structuredClone(fixture.orders);
  await fullSync(db, fakeShopify(who.orders as ShopifyOrder[]), shop, "admin:team@setustore.test");
  // Orders in the fixture are from 20 Nov 2026; keep them inside "the last 30 days" whenever this runs.
  await db.vendorOrderLine.updateMany({ where: { shop }, data: { orderCreatedAt: new Date(Date.now() - 3 * 86400000) } });
  const urban = await db.vendor.create({
    data: { shop, vendorName: "Urban Store", displayName: "Urban Store Co.", companyName: "Urban Store LLP", addressLine: "12 Mall Road", city: "Ludhiana", state: "Punjab", postalCode: "141001", minimumOrderValue: "1500", processingDaysMin: 10, processingDaysMax: 15, storeSyncedAt: new Date() },
  });
  await db.vendorUser.create({ data: { shop, vendorId: urban.id, email: "owner@urban.example", name: "Harpreet", status: "active", role: "owner" } });
  await db.vendorCommission.create({ data: { shop, vendorId: urban.id, ratePercent: "15", effectiveFrom: new Date(), setBy: "admin:team@setustore.test" } });
  await signUp(db, { name: "New Seller", email: "new@seller.example", password: "Strong-test-password-1", phone: "+91 90000 11111" }, { shop });
  await db.shopSetting.create({ data: { shop, deliveryDaysMin: 5, deliveryDaysMax: 7, updatedBy: "admin:team@setustore.test" } });
  const review = (customerId: number, rating: number, extra: object = {}) => db.vendorReview.create({
    data: { shop, vendorId: urban.id, customerId: BigInt(customerId), orderId: 1n, orderName: "#1003", authorName: "Meera", rating, comment: `Review number ${customerId}`, buyerLocation: "Pune, India", ...extra },
  });
  await review(1, 5);
  await review(2, 3, { status: "hidden", hiddenBy: "admin:team@setustore.test", hiddenReason: "Spam", hiddenAt: new Date() });
  // Mail: the sign-up above wrote one to the seller; add a team address, a mail that failed and one that was delivered.
  await db.shopSetting.update({ where: { shop }, data: { adminEmails: ["alerts@setustore.test"] } });
  await db.mailTemplateSetting.create({ data: { shop, template: "review_new", enabled: false } });
  const sent = { shop, audience: "seller", toEmail: "owner@urban.example", vendorId: urban.id, body: "x" };
  await db.mailMessage.create({ data: { ...sent, template: "order_new", subject: "New order #1003 for Urban Store Co.", status: "delivered", attempts: 1, sentAt: new Date() } });
  await db.mailMessage.create({ data: { ...sent, template: "commission_set", subject: "Your commission rate on Setu Store", status: "failed", attempts: 5, note: "The mail service refused it (422): Invalid `to` field" } });
  await db.mailMessage.create({ data: { ...sent, template: "password_reset", subject: "Reset your Setu Store vendor portal password", status: "logged", attempts: 1, note: "No mail service is set up, so this was not sent." } });
});
afterAll(cleanup);

const SHELL = `<style>body{font:14px/1.5 -apple-system,"Segoe UI",sans-serif;color:#1a1a1a;background:#f1f1f1;margin:0;padding:20px 28px}
s-page{display:block;max-width:1100px;margin:0 auto}s-page::before{content:attr(heading);display:block;font-size:22px;font-weight:650;margin:0 0 16px}
s-section{display:block;background:#fff;border-radius:12px;padding:16px;margin:0 0 16px;box-shadow:0 1px 2px rgba(0,0,0,.08)}
s-section[heading]::before{content:attr(heading);display:block;font-weight:650;font-size:15px;margin:0 0 10px}s-paragraph{display:block;margin:8px 0}
s-banner{display:block;border-radius:10px;padding:12px;margin:0 0 16px;background:#ffe9a8}s-banner[tone=critical]{background:#fdd}
s-link,a{color:#005bd3;text-decoration:underline}s-button{display:inline-block;padding:6px 12px;border-radius:8px;background:#fff;box-shadow:0 0 0 1px #ccc inset;font-weight:550}
s-button[variant=primary]{background:#303030;color:#fff}s-badge{display:inline-block;padding:1px 8px;border-radius:8px;background:#ffd6a4;font-size:12px}
s-badge[tone=success]{background:#b4fed2}s-badge[tone=critical]{background:#fdd}[slot=breadcrumb-actions]{display:block;margin:0 0 6px}th{font-weight:600}</style>`;

/** Runs a page's loader as Shopify admin would, draws the page with that data, and keeps a copy to look at. */
async function draw(name: keyof typeof pages, path: string, file: string) {
  const page = pages[name];
  const data = await (page.loader as (a: unknown) => Promise<unknown>)({ request: new Request("https://app.test" + path), params: {}, context: {} });
  who.data = JSON.parse(JSON.stringify(data)); // as it arrives in the browser
  const html = renderToStaticMarkup(createElement(page.default));
  mkdirSync(".cache/admin-preview", { recursive: true });
  writeFileSync(`.cache/admin-preview/${file}.html`, `<!doctype html><meta charset="utf-8"><title>${file}</title>${SHELL}${html}`);
  // The words on the page, with page and section headings (which are attributes) put in place.
  return html.replace(/<s-(?:page|section) heading="([^"]*)"[^>]*>/g, " $1 ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

describe("the team's pages draw from real data", () => {
  it("Dashboard: alerts with links, the four areas at a glance, the sales report, recent activity", async () => {
    const text = await draw("dashboard", "/app", "dashboard");
    for (const part of ["Needs your attention", "1 sign-up is waiting for approval", "At a glance", "Units to ship", "Delivery time 5–7 days", "Sales report: last 30 days", "Top vendors by sales", "Urban Store Co.", "Recent activity"]) {
      expect(text, part).toContain(part);
    }
    expect(text).toMatch(/Reviews 5\.0 \/ 5 1 published review, 1 hidden/);
    // Activity reads in plain words, and routine events (each order copied) are left out.
    for (const part of ["New sign-up", "new@seller.example (seller)", "All orders copied from Shopify", "team@setustore.test (team)"]) expect(text, part).toContain(part);
    for (const code of ["signup.created", "order.synced", "Order copied from Shopify", "admin:"]) expect(text, code).not.toContain(code);
  });

  it("Vendors: the same tabs on every view, and everything about a vendor in one row", async () => {
    const all = await draw("vendors", "/app/vendors", "vendors");
    for (const part of ["All vendors 1", "Needs attention 0", "Sign-ups 1", "Without portal access 1", "Urban Store Co.", "Shopify vendor: Urban Store", "Harpreet", "15%", "₹1,500.00", "10–15 days", "5.0 / 5", "Tools", "Update all store listings"]) {
      expect(all, part).toContain(part);
    }
    expect(await draw("vendors", "/app/vendors?view=attention", "vendors-attention")).toContain("No vendor needs anything from you.");
    const none = await draw("vendors", "/app/vendors?view=no-access", "vendors-no-access");
    expect(none).toContain("Shopify vendors without portal access");
    expect(none).toContain("Ashnur");
    expect(none).not.toContain("Tools");
    const waiting = await draw("signups", "/app/signups", "vendors-signups");
    for (const part of ["All vendors 1", "Sign-ups 1", "New Seller", "new@seller.example", "Approve", "Decline"]) expect(waiting, part).toContain(part);
  });

  it("Shipping and orders: shipping first, then sales by vendor and order sync as their own views", async () => {
    const shipping = await draw("orders", "/app/orders", "orders-shipping");
    for (const part of ["Shipping Sales by vendor", "Order sync", "Waiting to ship", "Delivery time, in days", "Now: 5–7 days", "Shipping times by seller", "15–22 days"]) expect(shipping, part).toContain(part);
    expect(shipping).not.toContain("Resync all orders");
    const sales = await draw("orders", "/app/orders?view=sales", "orders-sales");
    for (const part of ["Orders and sales by vendor", "Gross (₹)", "Urban Store", "Ashnur", "Not set up"]) expect(sales, part).toContain(part);
    expect(sales).not.toContain("Waiting to ship");
    const sync = await draw("orders", "/app/orders?view=sync", "orders-sync");
    for (const part of ["5 orders copied", "Resync all orders"]) expect(sync, part).toContain(part);
  });

  it("Reviews: numbers, filters and every seller's reviews with Hide or Show again; and ratings by seller", async () => {
    const all = await draw("reviews", "/app/reviews", "reviews");
    for (const part of ["All reviews 2", "By seller 1", "Average rating 5.0 / 5", "Published 1", "Hidden 1", "All sellers", "Published and hidden", "Review number 1", "Meera (Pune, India)", "order #1003", "Hidden by team@setustore.test: Spam", "Show again", "Hide"]) {
      expect(all, part).toContain(part);
    }
    const hidden = await draw("reviews", "/app/reviews?status=hidden", "reviews-hidden");
    expect(hidden).toContain("1 review match");
    expect(hidden).not.toContain("Review number 1");
    const bySeller = await draw("reviews", "/app/reviews?view=sellers", "reviews-sellers");
    for (const part of ["Ratings by seller", "Urban Store Co.", "See their reviews"]) expect(bySeller, part).toContain(part);
  });

  it("Mail: every mail with who gets it and its words; the log with what happened; the team's addresses", async () => {
    const mails = await draw("mail", "/app/mail", "mail");
    for (const part of [
      "No mail service is set up. Mails are kept in the log but not sent.", "Mails Log Team addresses 1 Settings", "Open Settings", "Sent 1 Last 7 days", "Waiting 1", "Failed 1", "Not sent 1",
      "Mails to sellers", "Account", "Orders", "Reviews", "Mails to the team", "Team alerts",
      "New order An order with the vendor's products is placed (one mail per order) Everyone active on the vendor's team On Switch off",
      "New review", "Off Switch on", "Password reset link", "Always on", "1 mail in total is switched off",
      "Read it, or send a test", "Subject New order #1042 for Ashnur", "Hello Priya,", "• 24 × Pillar Candle – Rose", "Send this example to", "Send test",
      "Orders past their processing time", "A seller's email is bouncing", "New 5-star review for Ashnur",
    ]) expect(mails, part).toContain(part);
    // The two mails that were dropped are not offered.
    expect(mails).not.toMatch(/summary|still incomplete/i);
    // A required mail has no switch: as many switches as mails that can be switched.
    expect(mails.match(/Switch (?:on|off)/g)!.length).toBe(mails.match(/Read it, or send a test/g)!.length - mails.match(/Always on/g)!.length);

    const log = await draw("mail", "/app/mail?view=log", "mail-log");
    for (const part of [
      "4 mails, newest first", "owner@urban.example Seller", "New order #1003 for Urban Store Co. New order Delivered",
      "Your commission rate on Setu Store Commission rate set Failed The mail service refused it (422): Invalid `to` field Send again",
      "Not sent No mail service is set up, so this was not sent.", "new@seller.example", "Sign-up received",
    ]) expect(log, part).toContain(part);
    // Only the failed mail can be sent again: one is still waiting, one carried a one-time link.
    expect(log.match(/Send again/g)).toHaveLength(1);
    expect(log).toContain("Waiting");
    const failed = await draw("mail", "/app/mail?view=log&status=failed", "mail-log-failed");
    expect(failed).toContain("1 mail match");
    expect(failed).toContain("Your commission rate on Setu Store");
    expect(failed).not.toContain("New order #1003");
    expect(await draw("mail", "/app/mail?view=log&to=nobody", "mail-log-none")).toContain("No mails match.");

    const team = await draw("mail", "/app/mail?view=team", "mail-team");
    for (const part of ["Team addresses", "Email addresses, one on each line (up to 10)", "alerts@setustore.test", "Save", "Sellers never see these addresses."]) expect(team, part).toContain(part);
  });

  it("Mail settings: every value with where it comes from, and never the key itself", async () => {
    const empty = await draw("mail", "/app/mail?view=settings", "mail-settings-empty");
    for (const part of [
      "Settings", "Resend API key", "None is set.", "Sender", "Name", "Address", "Reply address", "Test list", "Webhook signing secret", "Save",
      "This is a development copy: with an empty list it mails nobody", "Not set.", "Check these settings", "It sends nothing.",
    ]) expect(empty, part).toContain(part);
    expect(empty).not.toContain("Remove the saved key");

    // With values saved in the app (the key sealed with a server secret, as the app would).
    const { saveMailSettings } = await import("../app/lib/mail/config.server");
    process.env.SHOPIFY_API_SECRET = "render-test-secret";
    try {
      await saveMailSettings(db, shop, { apiKey: "re_RenderTestKey_4321", fromName: "Setu Store", fromAddress: "support@setustore.test", replyTo: "", onlyTo: "me@setustore.test" }, "admin:team@setustore.test");
      const page = pages.mail;
      const data = await (page.loader as (a: unknown) => Promise<unknown>)({ request: new Request("https://app.test/app/mail?view=settings"), params: {}, context: {} });
      expect(JSON.stringify(data)).not.toContain("re_RenderTestKey_4321");
      const saved = await draw("mail", "/app/mail?view=settings", "mail-settings");
      for (const part of [
        "Test mode: mails are really sent only to me@setustore.test.", "One is saved here, ending in 4321. Leave this empty to keep it.", "Remove the saved key",
        "Saved here.", "Last changed", "by team@setustore.test", "me@setustore.test",
      ]) expect(saved, part).toContain(part);
      expect(saved).not.toContain("re_RenderTestKey");
      expect(saved).not.toContain("Open Settings");
    } finally {
      delete process.env.SHOPIFY_API_SECRET;
      await db.mailSetting.deleteMany({ where: { shop } });
    }
  });
});
