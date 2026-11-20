import { describe, expect, it } from "vitest";
import { gidToId, lineStatus, orderToLines, summariseByVendor, type ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";

const orders = fixture.orders as ShopifyOrder[];
const byName = (n: string) => orders.find((o) => o.name === n)!;
const all = orders.flatMap(orderToLines);

describe("gidToId", () => {
  it("reads numeric IDs and rejects anything else", () => {
    expect(gidToId("gid://shopify/Order/19043720134765")).toBe(19043720134765n);
    expect(() => gidToId("19043720134765")).toThrow();
    expect(() => gidToId("gid://shopify/Order/12;DROP")).toThrow();
  });
});

describe("lineStatus", () => {
  it("covers every case", () => {
    expect(lineStatus(true, 5, 5)).toBe("cancelled");
    expect(lineStatus(false, 0, 0)).toBe("refunded");
    expect(lineStatus(false, 4, 4)).toBe("fulfilled");
    expect(lineStatus(false, 4, 1)).toBe("partial");
    expect(lineStatus(false, 4, 0)).toBe("unfulfilled");
  });
});

describe("orderToLines on the dev store test orders", () => {
  it("#1001 (T1): one Urban Store line, nothing shipped", () => {
    const [l] = orderToLines(byName("#1001"));
    expect(l).toMatchObject({ vendorName: "Urban Store", quantity: 2, lineTotal: "120.00", netAmount: "120.00", status: "unfulfilled", orderId: 19043720134765n });
  });

  it("#1002 (T2): refund of 1 ring lowers that line only", () => {
    const lines = orderToLines(byName("#1002"));
    const ring = lines.find((l) => l.sku === "urban_store898")!;
    expect(ring).toMatchObject({ quantity: 4, currentQuantity: 3, refundedQuantity: 1, refundedAmount: "75.00", lineTotal: "300.00", netAmount: "225.00", status: "unfulfilled" });
    const armlet = lines.find((l) => l.sku === "urban_store897")!;
    expect(armlet).toMatchObject({ refundedQuantity: 0, netAmount: "800.00" });
  });

  it("#1003 (T3): lines split between Urban Store and Ashnur", () => {
    const lines = orderToLines(byName("#1003"));
    expect(lines.filter((l) => l.vendorName === "Urban Store").map((l) => l.sku)).toEqual(["urban_store899", "urban_store900"]);
    expect(lines.filter((l) => l.vendorName === "Ashnur").map((l) => l.sku)).toEqual(["ASH-016", "ASH-001"]);
  });

  it("#1004 (T4): Urban Store shipped, Ashnur still to ship", () => {
    const lines = orderToLines(byName("#1004"));
    for (const l of lines.filter((x) => x.vendorName === "Urban Store")) expect(l.status).toBe("fulfilled");
    const candle = lines.find((l) => l.vendorName === "Ashnur")!;
    expect(candle).toMatchObject({ status: "unfulfilled", fulfilledQuantity: 0, variantTitle: '6"x4"' });
  });

  it("#1005 (T5): cancelled order, every line cancelled with net 0", () => {
    for (const l of orderToLines(byName("#1005"))) {
      expect(l.status).toBe("cancelled");
      expect(l.orderCancelled).toBe(true);
      expect(l.netAmount).toBe("0.00");
    }
  });
});

describe("summariseByVendor", () => {
  const s = summariseByVendor(all);
  const urban = s.find((v) => v.vendorName === "Urban Store")!;
  const ashnur = s.find((v) => v.vendorName === "Ashnur")!;

  it("lists exactly the two vendors that have orders", () => {
    expect(s.map((v) => v.vendorName)).toEqual(["Ashnur", "Urban Store"]);
  });

  it("Urban Store totals", () => {
    // gross 120 + 800 + 300 + 600 + 650 + 660 + 420 = 3550; #1005 cancelled adds nothing
    expect(urban).toEqual({ vendorName: "Urban Store", orders: 5, units: 51, gross: "3550.00", refunded: "75.00", net: "3475.00", unitsToShip: 33, openOrders: 3 });
  });

  it("Ashnur totals", () => {
    // gross 550 + 800 + 525 = 1875
    expect(ashnur).toEqual({ vendorName: "Ashnur", orders: 3, units: 10, gross: "1875.00", refunded: "0.00", net: "1875.00", unitsToShip: 10, openOrders: 2 });
  });

  it("a line with no vendor is kept under an empty name, not dropped", () => {
    const o = structuredClone(byName("#1001"));
    o.lineItems.nodes[0].vendor = null;
    expect(summariseByVendor(orderToLines(o))[0].vendorName).toBe("");
  });
});
