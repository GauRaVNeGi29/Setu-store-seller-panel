import type { PrismaClient } from "@prisma/client";
import { summariseByVendor } from "./map";

/** Read-only queries for the team's admin screens. Everything is filtered by shop. */

export async function vendorOverview(db: PrismaClient, shop: string) {
  const lines = await db.vendorOrderLine.findMany({
    where: { shop },
    select: { vendorName: true, orderId: true, currentQuantity: true, fulfilledQuantity: true, status: true, lineTotal: true, refundedAmount: true, netAmount: true },
  });
  const [state, orders] = await Promise.all([
    db.syncState.findUnique({ where: { shop } }),
    db.vendorOrderLine.findMany({ where: { shop }, select: { orderId: true }, distinct: ["orderId"] }),
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

export async function recentActivity(db: PrismaClient, shop: string, take = 15) {
  const rows = await db.auditLog.findMany({ where: { shop }, orderBy: { at: "desc" }, take });
  return rows.map((r) => ({ id: r.id.toString(), at: r.at.toISOString(), actor: r.actor, action: r.action, target: r.target }));
}
