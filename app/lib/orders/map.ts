import { Decimal } from "decimal.js";

/**
 * Turns one Shopify order (as read by ORDER_FIELDS in sync.server.ts) into one
 * row per line item, each carrying its vendor. Pure: no database, no network.
 *
 * Quantities:
 *   quantity          – as ordered
 *   currentQuantity   – after refunds, removals and cancellation (Shopify's own figure)
 *   refundedQuantity  – sum of refund line items for this line
 *   fulfilledQuantity – currentQuantity − unfulfilledQuantity
 *
 * Money (shop currency):
 *   lineTotal      – discountedTotalSet: after line and order discounts, before refunds
 *   refundedAmount – sum of refund line item subtotals for this line
 *   netAmount      – lineTotal − refundedAmount (never below 0)
 *
 * Shipping, taxes, duties and order-level adjustments are not split per vendor
 * here; commission rules (Stage 5) decide how those are treated.
 */

export type Money = { shopMoney: { amount: string; currencyCode?: string } };

export type ShopifyLineItem = {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  vendor: string | null;
  quantity: number;
  currentQuantity: number;
  unfulfilledQuantity: number;
  product: { id: string } | null;
  variant: { id: string } | null;
  originalUnitPriceSet: Money;
  discountedTotalSet: Money;
};

export type ShopifyRefund = {
  id: string;
  refundLineItems: { nodes: { quantity: number; lineItem: { id: string }; subtotalSet: Money }[] };
};

export type ShopifyOrder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  currencyCode: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  lineItems: { nodes: ShopifyLineItem[] };
  refunds: ShopifyRefund[];
};

export type LineStatus = "unfulfilled" | "partial" | "fulfilled" | "refunded" | "cancelled";

export type VendorLine = {
  lineItemId: bigint;
  orderId: bigint;
  orderName: string;
  vendorName: string;
  productId: bigint | null;
  variantId: bigint | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  currentQuantity: number;
  refundedQuantity: number;
  fulfilledQuantity: number;
  currency: string;
  unitPrice: string;
  lineTotal: string;
  refundedAmount: string;
  netAmount: string;
  status: LineStatus;
  orderCancelled: boolean;
  financialStatus: string;
  fulfillmentStatus: string;
  orderCreatedAt: Date;
  orderUpdatedAt: Date;
};

/** "gid://shopify/Order/123" → 123n. Throws on anything else. */
export function gidToId(gid: string): bigint {
  const m = /^gid:\/\/shopify\/[A-Za-z]+\/(\d+)$/.exec(gid);
  if (!m) throw new Error(`Not a Shopify ID: ${gid}`);
  return BigInt(m[1]);
}

const money = (m: Money | null | undefined) => new Decimal(m?.shopMoney.amount ?? "0");
const fixed = (d: Decimal) => d.toFixed(2);

export function lineStatus(cancelled: boolean, current: number, fulfilled: number): LineStatus {
  if (cancelled) return "cancelled";
  if (current <= 0) return "refunded";
  if (fulfilled >= current) return "fulfilled";
  if (fulfilled > 0) return "partial";
  return "unfulfilled";
}

export function orderToLines(order: ShopifyOrder): VendorLine[] {
  const refunded = new Map<string, { qty: number; amount: Decimal }>();
  for (const r of order.refunds ?? []) {
    for (const rl of r.refundLineItems.nodes) {
      const cur = refunded.get(rl.lineItem.id) ?? { qty: 0, amount: new Decimal(0) };
      refunded.set(rl.lineItem.id, { qty: cur.qty + rl.quantity, amount: cur.amount.plus(money(rl.subtotalSet)) });
    }
  }

  const cancelled = Boolean(order.cancelledAt);
  const orderId = gidToId(order.id);

  return order.lineItems.nodes.map((li) => {
    const r = refunded.get(li.id) ?? { qty: 0, amount: new Decimal(0) };
    const lineTotal = money(li.discountedTotalSet);
    const net = Decimal.max(0, lineTotal.minus(r.amount));
    const fulfilled = Math.max(0, li.currentQuantity - li.unfulfilledQuantity);
    return {
      lineItemId: gidToId(li.id),
      orderId,
      orderName: order.name,
      vendorName: (li.vendor ?? "").trim(),
      productId: li.product ? gidToId(li.product.id) : null,
      variantId: li.variant ? gidToId(li.variant.id) : null,
      title: li.title,
      variantTitle: li.variantTitle,
      sku: li.sku,
      quantity: li.quantity,
      currentQuantity: li.currentQuantity,
      refundedQuantity: r.qty,
      fulfilledQuantity: fulfilled,
      currency: order.currencyCode,
      unitPrice: fixed(money(li.originalUnitPriceSet)),
      lineTotal: fixed(lineTotal),
      refundedAmount: fixed(r.amount),
      netAmount: fixed(net),
      status: lineStatus(cancelled, li.currentQuantity, fulfilled),
      orderCancelled: cancelled,
      financialStatus: order.displayFinancialStatus ?? "",
      fulfillmentStatus: order.displayFulfillmentStatus,
      orderCreatedAt: new Date(order.createdAt),
      orderUpdatedAt: new Date(order.updatedAt),
    };
  });
}

/** Per-vendor totals for the team screen. Cancelled lines count as orders but add no money. */
export type VendorSummary = {
  vendorName: string;
  orders: number;
  units: number;
  gross: string;
  refunded: string;
  net: string;
  unitsToShip: number;
  openOrders: number;
};

type SummaryInput = Pick<VendorLine, "vendorName" | "orderId" | "currentQuantity" | "fulfilledQuantity" | "status"> & {
  lineTotal: string | { toString(): string };
  refundedAmount: string | { toString(): string };
  netAmount: string | { toString(): string };
};

export function summariseByVendor(lines: SummaryInput[]): VendorSummary[] {
  const by = new Map<string, { orders: Set<bigint>; open: Set<bigint>; units: number; gross: Decimal; refunded: Decimal; net: Decimal; toShip: number }>();
  for (const l of lines) {
    const s = by.get(l.vendorName) ?? { orders: new Set(), open: new Set(), units: 0, gross: new Decimal(0), refunded: new Decimal(0), net: new Decimal(0), toShip: 0 };
    s.orders.add(l.orderId);
    if (l.status !== "cancelled") {
      s.units += l.currentQuantity;
      s.gross = s.gross.plus(String(l.lineTotal));
      s.refunded = s.refunded.plus(String(l.refundedAmount));
      s.net = s.net.plus(String(l.netAmount));
      const toShip = Math.max(0, l.currentQuantity - l.fulfilledQuantity);
      s.toShip += toShip;
      if (toShip > 0) s.open.add(l.orderId);
    }
    by.set(l.vendorName, s);
  }
  return [...by.entries()]
    .map(([vendorName, s]) => ({
      vendorName,
      orders: s.orders.size,
      units: s.units,
      gross: fixed(s.gross),
      refunded: fixed(s.refunded),
      net: fixed(s.net),
      unitsToShip: s.toShip,
      openOrders: s.open.size,
    }))
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}
