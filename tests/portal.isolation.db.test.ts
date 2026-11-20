import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestCode, verifyCode, COOKIE_NAME } from "../app/lib/portal/auth.server";
import { saveOrder } from "../app/lib/orders/sync.server";
import { addVendorUser, enableVendor } from "../app/lib/vendors/vendors.server";
import type { ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";
import * as myOrders from "../app/routes/portal._index";
import * as orderDetail from "../app/routes/portal.orders.$orderId";
import * as toShip from "../app/routes/portal.ship";
import * as layout from "../app/routes/portal";
import * as login from "../app/routes/portal_.login";

/**
 * Vendor isolation, tested through the real page loaders with real cookies.
 * Ashnur signs in and tries every way to reach Urban Store's data.
 * Shop = PORTAL_SHOP from vitest.config.ts.
 */

const db = new PrismaClient();
const shop = "seller-panel-dev.myshopify.com";
const otherShop = "someone-else.myshopify.com";
const base = "https://portal.test";
let ashnurCookie = "";
let urbanCookie = "";

const orders = () => structuredClone(fixture.orders) as ShopifyOrder[];
const URBAN_MARKERS = ["Urban Store", "urban_store", "Statement Ring", "Armlet"];

async function cleanup() {
  for (const s of [shop, otherShop]) {
    await db.portalSession.deleteMany({ where: { vendorUser: { shop: s } } });
    await db.vendorUser.deleteMany({ where: { shop: s } });
    await db.vendor.deleteMany({ where: { shop: s } });
    await db.loginCode.deleteMany({ where: { shop: s } });
    await db.vendorOrderLine.deleteMany({ where: { shop: s } });
    await db.auditLog.deleteMany({ where: { shop: s } });
  }
}

async function cookieFor(email: string) {
  const r = await requestCode(db, email, { shop });
  if (r.status !== "sent") throw new Error("code not sent");
  const v = await verifyCode(db, email, r.code, { shop });
  if (!v.ok) throw new Error("verify failed");
  return `${COOKIE_NAME}=${encodeURIComponent(v.token)}`;
}

const req = (path: string, cookie?: string, init: RequestInit = {}) =>
  new Request(base + path, { ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) } });

type Loader = (args: { request: Request; params: Record<string, string>; context: unknown }) => Promise<unknown>;
async function load(mod: { loader: unknown }, path: string, cookie?: string, params: Record<string, string> = {}) {
  try {
    return { data: await (mod.loader as Loader)({ request: req(path, cookie), params, context: {} }), status: 200 };
  } catch (e) {
    if (e instanceof Response) return { response: e, status: e.status, location: e.headers.get("Location") };
    throw e;
  }
}
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

beforeAll(async () => {
  await cleanup();
  for (const o of orders()) await saveOrder(db, shop, o, "test");
  // Same orders in another shop: must never appear in this portal.
  for (const o of orders()) {
    o.lineItems.nodes.forEach((li) => { li.id = li.id.replace(/(\d+)$/, (d) => String(BigInt(d) + 1n)); });
    await saveOrder(db, otherShop, o, "test");
  }
  const ashnur = await enableVendor(db, shop, "Ashnur", "test");
  const urban = await enableVendor(db, shop, "Urban Store", "test");
  await addVendorUser(db, shop, ashnur.id, "nusrat@ashnur.example", "Nusrat", "test");
  await addVendorUser(db, shop, urban.id, "owner@urban.example", null, "test");
  ashnurCookie = await cookieFor("nusrat@ashnur.example");
  urbanCookie = await cookieFor("owner@urban.example");
});
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("signed-out access", () => {
  it.each([
    ["my orders", myOrders, "/portal"],
    ["order detail", orderDetail, "/portal/orders/19043720298605"],
    ["what to ship", toShip, "/portal/ship"],
    ["layout", layout, "/portal"],
  ])("%s redirects to login without a cookie or with a forged one", async (_n, mod, path) => {
    for (const cookie of [undefined, `${COOKIE_NAME}=forged-token-value-1234567890abcdefghijk`, `${COOKIE_NAME}=`]) {
      const r = await load(mod, path, cookie, { orderId: "19043720298605" });
      expect(r.status).toBe(302);
      expect(r.location).toBe("/portal/login");
    }
  });
});

describe("Ashnur sees only Ashnur", () => {
  it("My orders lists only orders with Ashnur items, with Ashnur's numbers", async () => {
    const r = await load(myOrders, "/portal", ashnurCookie);
    const d = r.data as { orders: { orderName: string; net: string; toShip: number }[]; total: number };
    expect(d.orders.map((o) => o.orderName).sort()).toEqual(["#1003", "#1004", "#1005"]);
    expect(d.orders.find((o) => o.orderName === "#1003")).toMatchObject({ net: "1350.00", toShip: 7 });
    for (const m of URBAN_MARKERS) expect(json(r.data)).not.toContain(m);
  });

  it("ignores any vendor or shop named in the URL", async () => {
    const r = await load(myOrders, "/portal?vendor=Urban%20Store&vendorName=Urban%20Store&shop=other", ashnurCookie);
    for (const m of URBAN_MARKERS) expect(json(r.data)).not.toContain(m);
  });

  it("an order with both vendors shows only Ashnur's lines", async () => {
    const r = await load(orderDetail, "/portal/orders/19043720298605", ashnurCookie, { orderId: "19043720298605" });
    const d = r.data as { order: { lines: { sku: string }[] } };
    expect(d.order.lines.map((l) => l.sku)).toEqual(["ASH-016", "ASH-001"]);
    for (const m of URBAN_MARKERS) expect(json(r.data)).not.toContain(m);
  });

  it("an Urban-only order is 'not found', exactly like an order that doesn't exist", async () => {
    const urbanOnly = await load(orderDetail, "/portal/orders/19043720134765", ashnurCookie, { orderId: "19043720134765" });
    const missing = await load(orderDetail, "/portal/orders/99999999999999", ashnurCookie, { orderId: "99999999999999" });
    expect(urbanOnly.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await urbanOnly.response!.text()).toBe(await missing.response!.text());
  });

  it.each(["19043720134765 OR 1=1", "-1", "0x1F", "gid://shopify/Order/19043720134765", "1".repeat(40), "", "19043720134765/../19043720298605"])(
    "tampered order id %j is not found",
    async (orderId) => {
      const r = await load(orderDetail, `/portal/orders/${encodeURIComponent(orderId)}`, ashnurCookie, { orderId });
      expect(r.status).toBe(404);
    },
  );

  it("What to ship lists only Ashnur units", async () => {
    const r = await load(toShip, "/portal/ship", ashnurCookie);
    const d = r.data as { units: number; orders: { orderName: string }[] };
    expect(d.units).toBe(10);
    expect(d.orders.map((o) => o.orderName)).toEqual(["#1003", "#1004"]);
    for (const m of URBAN_MARKERS) expect(json(r.data)).not.toContain(m);
  });

  it("never shows data from another shop with the same vendor name", async () => {
    const r = await load(myOrders, "/portal", ashnurCookie);
    expect((r.data as { total: number }).total).toBe(3); // not 6
  });
});

describe("Urban Store sees only Urban Store", () => {
  it("cannot open Ashnur's lines, and its own totals are right", async () => {
    const r = await load(orderDetail, "/portal/orders/19043720298605", urbanCookie, { orderId: "19043720298605" });
    const d = r.data as { order: { lines: { sku: string }[]; net: string } };
    expect(d.order.lines.every((l) => l.sku.startsWith("urban_store"))).toBe(true);
    expect(d.order.net).toBe("1250.00");
    expect(json(r.data)).not.toContain("ASH-");
    expect(json(r.data)).not.toContain("Candle");
  });
});

describe("login page", () => {
  type Act = (args: { request: Request; params: Record<string, string>; context: unknown }) => Promise<unknown>;
  const post = (fields: Record<string, string>) =>
    (login.action as Act)({ request: req("/portal/login", undefined, { method: "POST", body: new URLSearchParams(fields) }), params: {}, context: {} });

  it("answers the same for an email with access and one without", async () => {
    const known = await post({ intent: "request", email: "nusrat@ashnur.example" });
    const unknown = await post({ intent: "request", email: "stranger@example.com" });
    expect(known).toEqual({ step: "code", email: "nusrat@ashnur.example", resent: false }); // no devCode unless enabled
    expect(unknown).toEqual({ step: "code", email: "stranger@example.com", resent: false });
  });

  it("with PORTAL_DEV_SHOW_CODE in development, the code is shown – and it works", async () => {
    process.env.PORTAL_DEV_SHOW_CODE = "true";
    try {
      const r = (await post({ intent: "request", email: "nusrat@ashnur.example" })) as { devCode?: string };
      expect(r.devCode).toMatch(/^\d{6}$/);
      const unknown = (await post({ intent: "request", email: "stranger2@example.com" })) as { devCode?: string };
      expect(unknown.devCode).toBeUndefined();
      const v = await post({ intent: "verify", email: "nusrat@ashnur.example", code: r.devCode! });
      expect(v).toBeInstanceOf(Response);
      expect((v as Response).headers.get("Set-Cookie")).toContain("__Host-vp_session=");
    } finally {
      delete process.env.PORTAL_DEV_SHOW_CODE;
    }
  });

  it("a wrong code gives a generic error and no cookie", async () => {
    const r = await post({ intent: "verify", email: "nusrat@ashnur.example", code: "000000" });
    expect(r).toMatchObject({ step: "code", error: expect.stringContaining("didn't work") });
  });
});
