import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveOrder } from "../app/lib/orders/sync.server";
import { sellerDashboard } from "../app/lib/portal/dashboard.server";
import type { ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";

/**
 * The seller dashboard's numbers, worked out by hand from the dev store's
 * five test orders (all placed 20 Nov 2026), with "today" fixed.
 *
 * Urban Store: #1001 ₹120 · #1002 ₹1,100 − ₹75 refund · #1003 ₹1,250 · #1004 ₹1,080 (shipped) · #1005 cancelled
 *   → sales ₹3,475, 4 orders, 51 units, ₹75 refunded, 33 units to ship in 3 orders.
 */
const db = new PrismaClient();
const shop = "dashboard-test.myshopify.com";
const urban = { shop, vendorName: "Urban Store" };
const ashnur = { shop, vendorName: "Ashnur" };
const TODAY = new Date("2026-11-23T06:30:00Z"); // 12:00 in India

beforeAll(async () => {
  await db.vendorOrderLine.deleteMany({ where: { shop } });
  for (const o of structuredClone(fixture.orders) as ShopifyOrder[]) await saveOrder(db, shop, o, "test");
});
afterAll(async () => {
  await db.vendorOrderLine.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
  await db.$disconnect();
});

describe("seller dashboard", () => {
  it("adds up sales, orders, units, average order and refunds for the period", async () => {
    const d = await sellerDashboard(db, urban, "7", TODAY);
    expect(d.sales).toEqual({ net: "3475.00", previous: "0.00", change: null });
    expect(d.kpis).toEqual({
      orders: { value: 4, previous: 0 },
      units: { value: 51, previous: 0 },
      aov: { value: "868.75", previous: null },
      refunded: { value: "75.00", previous: "0.00" },
    });
    expect(d.status).toEqual({ shipped: 1, open: 3, cancelled: 1 });
  });

  it("puts each order on the day it was placed (India time), in a bar per day", async () => {
    const d = await sellerDashboard(db, urban, "7", TODAY);
    expect(d.bucket).toBe("day");
    expect(d.series.map((s) => s.key)).toEqual(["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]);
    expect(d.series.find((s) => s.key === "2026-11-20")).toMatchObject({ net: "3475.00", orders: 4 });
    expect(d.series.filter((s) => s.net !== "0.00")).toHaveLength(1);
  });

  it("uses weeks for 90 days and months for all time", async () => {
    const w = await sellerDashboard(db, urban, "90", TODAY);
    expect(w.bucket).toBe("week");
    expect(w.series.every((s) => new Date(`${s.key}T00:00:00Z`).getUTCDay() === 1)).toBe(true); // weeks start Monday
    expect(w.series.find((s) => s.key === "2026-11-16")?.net).toBe("3475.00");
    const m = await sellerDashboard(db, urban, "all", TODAY);
    expect(m.bucket).toBe("month");
    expect(m.series.at(-1)).toMatchObject({ key: "2026-11", net: "3475.00" });
    expect(m.sales.previous).toBeNull(); // nothing to compare all time with
  });

  it("compares with the period before: a quiet week shows a 100% drop", async () => {
    const d = await sellerDashboard(db, urban, "7", new Date("2026-11-29T06:30:00Z"));
    expect(d.sales).toEqual({ net: "0.00", previous: "3475.00", change: -100 });
    expect(d.kpis.orders).toEqual({ value: 0, previous: 4 });
    expect(d.recent).toEqual([]);
    expect(d.toShip.units).toBe(33); // still waiting, whatever the period
  });

  it("lists top products by sales, latest orders newest first, and the oldest orders to ship", async () => {
    const d = await sellerDashboard(db, urban, "30", TODAY);
    expect(d.topProducts.map((p) => [p.title, p.net, p.units])).toEqual([
      ["Elegant Spiral Golden Armlet", "800.00", 8],
      ["Molten Heart Statement Ring", "660.00", 12],
      ["Bold Chain Link Statement Ring", "650.00", 10],
      ["Twisted Golden Statement Ring", "600.00", 10],
      ["Aurora Swirl Pearl Statement Ring", "420.00", 6],
    ]);
    expect(d.recent.map((o) => [o.orderName, o.status])).toEqual([
      ["#1005", "cancelled"], ["#1004", "shipped"], ["#1003", "to_ship"], ["#1002", "to_ship"], ["#1001", "to_ship"],
    ]);
    expect(d.toShip).toMatchObject({ units: 33, orders: 3 });
    expect(d.toShip.oldest.map((o) => [o.orderName, o.toShip, o.daysWaiting])).toEqual([["#1001", 2, 3], ["#1002", 11, 3], ["#1003", 20, 3]]);
  });

  it("another vendor's dashboard has only its own lines", async () => {
    const d = await sellerDashboard(db, ashnur, "all", TODAY);
    expect(d.sales.net).toBe("1875.00");
    expect(d.kpis.orders.value).toBe(2);
    expect(d.topProducts.every((p) => /Candle/.test(p.title))).toBe(true);
    expect(d.recent.map((o) => o.orderName).sort()).toEqual(["#1003", "#1004", "#1005"]);
  });

  it("a vendor with no orders gets zeros, not errors", async () => {
    const d = await sellerDashboard(db, { shop, vendorName: "Nobody Yet" }, "30", TODAY);
    expect(d.hasOrders).toBe(false);
    expect(d.sales.net).toBe("0.00");
    expect(d.kpis.aov.value).toBeNull();
    expect(d.series).toHaveLength(30);
    expect(d.topProducts).toEqual([]);
  });
});
