import type { PrismaClient } from "@prisma/client";
import { summariseByVendor, type VendorSummary } from "./map";

/** Read-only queries for the team's admin screens. Everything is filtered by shop. */

/** Totals for each vendor. With `since`, only orders placed from that moment on. */
export async function vendorOverview(db: PrismaClient, shop: string, since?: Date) {
  const lines = await db.vendorOrderLine.findMany({
    where: { shop, ...(since ? { orderCreatedAt: { gte: since } } : {}) },
    select: { vendorName: true, orderId: true, currentQuantity: true, fulfilledQuantity: true, status: true, lineTotal: true, refundedAmount: true, netAmount: true },
  });
  const [state, orders] = await Promise.all([
    db.syncState.findUnique({ where: { shop } }),
    db.vendorOrderLine.findMany({ where: { shop, ...(since ? { orderCreatedAt: { gte: since } } : {}) }, select: { orderId: true }, distinct: ["orderId"] }),
  ]);
  return {
    vendors: summariseByVendor(lines),
    orderCount: orders.length,
    lastFullSyncAt: state?.lastFullSyncAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
  };
}

/** One vendor's lines, newest order first. Only that vendor's lines are returned. */
export async function vendorLines(db: PrismaClient, shop: string, vendorName: string) {
  const rows = await db.vendorOrderLine.findMany({
    where: { shop, vendorName },
    orderBy: [{ orderCreatedAt: "desc" }, { lineItemId: "asc" }],
  });
  return rows.map((r) => ({
    lineItemId: r.lineItemId.toString(),
    orderId: r.orderId.toString(),
    orderName: r.orderName,
    title: r.variantTitle ? `${r.title} – ${r.variantTitle}` : r.title,
    sku: r.sku,
    quantity: r.quantity,
    currentQuantity: r.currentQuantity,
    refundedQuantity: r.refundedQuantity,
    fulfilledQuantity: r.fulfilledQuantity,
    toShip: r.status === "cancelled" ? 0 : Math.max(0, r.currentQuantity - r.fulfilledQuantity),
    unitPrice: r.unitPrice.toFixed(2),
    lineTotal: r.lineTotal.toFixed(2),
    refundedAmount: r.refundedAmount.toFixed(2),
    netAmount: r.netAmount.toFixed(2),
    status: r.status,
    financialStatus: r.financialStatus,
    orderCreatedAt: r.orderCreatedAt.toISOString(),
  }));
}

/** Adds up the vendors' rows: what the whole store sold, and what is still to ship. */
export function storeTotals(vendors: VendorSummary[]) {
  const sum = (pick: (v: VendorSummary) => number) => vendors.reduce((n, v) => n + pick(v), 0);
  return {
    units: sum((v) => v.units),
    net: sum((v) => Number(v.net)).toFixed(2),
    unitsToShip: sum((v) => v.unitsToShip),
    vendorsToShip: vendors.filter((v) => v.unitsToShip > 0).length,
  };
}

/** Events that happen all day and say little on their own: left out of the Dashboard's short list. */
const ROUTINE = ["order.synced", "order.removed", "login.success", "login.failed"];

/** The latest entries in the activity record. `notable` leaves out routine ones (each order copied, each sign-in). */
export async function recentActivity(db: PrismaClient, shop: string, take = 15, notable = false) {
  const rows = await db.auditLog.findMany({ where: { shop, ...(notable ? { action: { notIn: ROUTINE } } : {}) }, orderBy: { at: "desc" }, take });
  return rows.map((r) => ({ id: r.id.toString(), at: r.at.toISOString(), actor: r.actor, action: r.action, target: r.target }));
}
