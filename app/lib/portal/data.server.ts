import type { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

/**
 * Stage 4 – what a signed-in vendor can read.
 *
 * Every function takes the vendor from the session (never from the request)
 * and filters by shop AND vendorName in the database query itself. A vendor
 * asking for another vendor's order gets the same answer as for an order that
 * doesn't exist: nothing.
 *
 * Shown to vendors: order number and date, their own items, quantities,
 * prices, refunds, shipping status. Not shown: other vendors' items, the
 * order's grand total, the buyer's name, email, phone or address.
 */

export type VendorScope = { shop: string; vendorName: string };

export type OrderFilter = "all" | "to_ship" | "shipped" | "cancelled";
const PAGE_SIZE = 25;

const money = (d: { toFixed(n: number): string }) => d.toFixed(2);

type Line = Awaited<ReturnType<PrismaClient["vendorOrderLine"]["findMany"]>>[number];

function orderStatus(lines: Line[]): "to_ship" | "partly_shipped" | "shipped" | "refunded" | "cancelled" {
  if (lines.every((l) => l.status === "cancelled")) return "cancelled";
  const live = lines.filter((l) => l.status !== "cancelled" && l.status !== "refunded");
  if (!live.length) return "refunded";
  if (live.every((l) => l.status === "fulfilled")) return "shipped";
  if (live.some((l) => l.status === "fulfilled" || l.status === "partial")) return "partly_shipped";
  return "to_ship";
}

function summarise(lines: Line[]) {
  const first = lines[0];
  const live = lines.filter((l) => l.status !== "cancelled");
  const sum = (f: (l: Line) => number) => live.reduce((a, l) => a + f(l), 0);
  return {
    orderId: first.orderId.toString(),
    orderName: first.orderName,
    createdAt: first.orderCreatedAt.toISOString(),
    status: orderStatus(lines),
    items: lines.length,
    units: sum((l) => l.currentQuantity),
    toShip: sum((l) => Math.max(0, l.currentQuantity - l.fulfilledQuantity)),
    net: money(live.reduce((a, l) => a.plus(l.netAmount.toString()), new Decimal(0))),
  };
}

/** "My orders": one row per order containing this vendor's items, newest first. */
export async function listMyOrders(db: PrismaClient, scope: VendorScope, filter: OrderFilter = "all", page = 1) {
  const lines = await db.vendorOrderLine.findMany({
    where: { shop: scope.shop, vendorName: scope.vendorName },
    orderBy: [{ orderCreatedAt: "desc" }, { lineItemId: "asc" }],
  });
  const byOrder = new Map<string, Line[]>();
  for (const l of lines) {
    const k = l.orderId.toString();
    byOrder.set(k, [...(byOrder.get(k) ?? []), l]);
  }
  let orders = [...byOrder.values()].map(summarise);
  if (filter === "to_ship") orders = orders.filter((o) => o.toShip > 0);
  if (filter === "shipped") orders = orders.filter((o) => o.status === "shipped");
  if (filter === "cancelled") orders = orders.filter((o) => o.status === "cancelled" || o.status === "refunded");
  const safePage = Math.max(1, Math.floor(page) || 1);
  return {
    orders: orders.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    total: orders.length,
    page: safePage,
    pageSize: PAGE_SIZE,
  };
}

/** One order, only this vendor's lines. null when the vendor has no lines in it (or it doesn't exist). */
export async function getMyOrder(db: PrismaClient, scope: VendorScope, rawOrderId: string) {
  if (!/^\d{1,20}$/.test(rawOrderId)) return null;
  const lines = await db.vendorOrderLine.findMany({
    where: { shop: scope.shop, vendorName: scope.vendorName, orderId: BigInt(rawOrderId) },
    orderBy: { lineItemId: "asc" },
  });
  if (!lines.length) return null;
  return {
    ...summarise(lines),
    lines: lines.map((l) => ({
      lineItemId: l.lineItemId.toString(),
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      refundedQuantity: l.refundedQuantity,
      shipped: l.fulfilledQuantity,
      toShip: l.status === "cancelled" ? 0 : Math.max(0, l.currentQuantity - l.fulfilledQuantity),
      unitPrice: money(l.unitPrice),
      lineTotal: money(l.lineTotal),
      refundedAmount: money(l.refundedAmount),
      netAmount: money(l.netAmount),
      status: l.status,
    })),
  };
}

/** "What to ship": every unit still to send, grouped by order, oldest order first. */
export async function listToShip(db: PrismaClient, scope: VendorScope) {
  const lines = await db.vendorOrderLine.findMany({
    where: { shop: scope.shop, vendorName: scope.vendorName, status: { in: ["unfulfilled", "partial"] } },
    orderBy: [{ orderCreatedAt: "asc" }, { lineItemId: "asc" }],
  });
  const groups = new Map<string, { orderId: string; orderName: string; createdAt: string; items: { title: string; sku: string | null; toShip: number }[] }>();
  for (const l of lines) {
    const toShip = Math.max(0, l.currentQuantity - l.fulfilledQuantity);
    if (!toShip) continue;
    const k = l.orderId.toString();
    const g = groups.get(k) ?? { orderId: k, orderName: l.orderName, createdAt: l.orderCreatedAt.toISOString(), items: [] };
    g.items.push({ title: l.variantTitle ? `${l.title} – ${l.variantTitle}` : l.title, sku: l.sku, toShip });
    groups.set(k, g);
  }
  const orders = [...groups.values()];
  return { orders, units: orders.reduce((a, o) => a + o.items.reduce((b, i) => b + i.toShip, 0), 0) };
}
