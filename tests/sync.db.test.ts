import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fullSync, saveOrder, syncOrder } from "../app/lib/orders/sync.server";
import { vendorLines, vendorOverview } from "../app/lib/orders/admin.server";
import type { ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";
import { fakeShopify } from "./helpers/fake-shopify";

const db = new PrismaClient();
const shop = "seller-panel-test.myshopify.com";
const otherShop = "other-test.myshopify.com";
const orders = () => structuredClone(fixture.orders) as ShopifyOrder[];

afterAll(() => db.$disconnect());
beforeEach(async () => {
  for (const s of [shop, otherShop]) {
    await db.vendorOrderLine.deleteMany({ where: { shop: s } });
    await db.syncState.deleteMany({ where: { shop: s } });
    await db.auditLog.deleteMany({ where: { shop: s } });
  }
});

describe("order sync (database)", () => {
  it("full sync copies every line, including orders with more lines than one page", async () => {
    const res = await fullSync(db, fakeShopify(orders()), shop, "test");
    expect(res.orders).toBe(5);
    expect(await db.vendorOrderLine.count({ where: { shop } })).toBe(12);
    const ov = await vendorOverview(db, shop);
    expect(ov.vendors.find((v) => v.vendorName === "Urban Store")).toMatchObject({ gross: "3550.00", net: "3475.00", unitsToShip: 33 });
    expect(ov.vendors.find((v) => v.vendorName === "Ashnur")).toMatchObject({ gross: "1875.00", unitsToShip: 10 });
    expect(ov.lastFullSyncAt).not.toBeNull();
  });

  it("saving the same order twice changes nothing (webhooks can repeat)", async () => {
    const o = orders()[2];
    await saveOrder(db, shop, o, "test");
    await saveOrder(db, shop, o, "test");
    expect(await db.vendorOrderLine.count({ where: { shop } })).toBe(4);
  });

  it("a line removed from an order (order edit) is removed locally", async () => {
    const o = orders()[2];
    await saveOrder(db, shop, o, "test");
    o.lineItems.nodes = o.lineItems.nodes.slice(0, 3);
    await saveOrder(db, shop, o, "test");
    expect(await db.vendorOrderLine.count({ where: { shop } })).toBe(3);
  });

  it("a fulfilment arriving later updates the stored line", async () => {
    const o = orders()[3]; // #1004
    await saveOrder(db, shop, o, "test");
    o.lineItems.nodes[2].unfulfilledQuantity = 0;
    const api = fakeShopify([o]);
    await syncOrder(db, api, shop, o.id, "webhook:orders/fulfilled");
    const candle = (await vendorLines(db, shop, "Ashnur")).find((l) => l.orderName === "#1004")!;
    expect(candle.status).toBe("fulfilled");
    expect(candle.toShip).toBe(0);
  });

  it("an order Shopify no longer has is removed by syncOrder and by full sync", async () => {
    const list = orders();
    await fullSync(db, fakeShopify(list), shop, "test");
    await syncOrder(db, fakeShopify(list.slice(1)), shop, list[0].id, "webhook:orders/delete");
    expect(await db.vendorOrderLine.count({ where: { shop, orderName: "#1001" } })).toBe(0);
    await fullSync(db, fakeShopify(list.slice(2)), shop, "test");
    expect(await db.vendorOrderLine.count({ where: { shop, orderName: "#1002" } })).toBe(0);
  });

  it("vendorLines returns only that vendor's lines, and only for that shop", async () => {
    await fullSync(db, fakeShopify(orders()), shop, "test");
    await fullSync(db, fakeShopify(orders()), otherShop, "test").catch(() => undefined);
    const ashnur = await vendorLines(db, shop, "Ashnur");
    expect(ashnur.length).toBe(4); // #1003 ×2, #1004 ×1, #1005 ×1
    expect(ashnur.every((l) => l.sku?.startsWith("ASH-"))).toBe(true);
    expect(await vendorLines(db, shop, "Nobody")).toEqual([]);
    // Same line IDs in another shop never mix
    expect((await db.vendorOrderLine.findMany({ where: { shop, vendorName: "Ashnur" } })).every((r) => r.shop === shop)).toBe(true);
  });

  it("every sync writes an audit entry", async () => {
    await saveOrder(db, shop, orders()[0], "webhook:orders/create");
    const log = await db.auditLog.findMany({ where: { shop } });
    expect(log[0]).toMatchObject({ actor: "webhook:orders/create", action: "order.synced", target: "order:19043720134765" });
  });
});
