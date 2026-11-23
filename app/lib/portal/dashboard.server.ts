import type { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import type { VendorScope } from "./data.server";

/**
 * The seller's dashboard: their own numbers only (shop AND vendorName in the
 * query, from the session), for a chosen period, compared with the period
 * just before it.
 *
 * Definitions (the same as My orders):
 *  - An order counts in the period it was placed (India time).
 *  - Sales = this vendor's line totals after discounts, minus refunds;
 *    cancelled orders add nothing.
 *  - Units = units still on the order after refunds and removals.
 *  - Order status: open (something still to ship), shipped, or cancelled
 *    (cancelled, or every unit refunded).
 */

import { RANGES, type RangeKey } from "./ranges";
export { RANGES, isRange, type RangeKey } from "./ranges";

const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
/** Calendar day in India as "YYYY-MM-DD". */
const istDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
/** Midnight India time at the start of the given IST day, as a Date. */
const istMidnight = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST_MS);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const mondayOf = (day: string) => {
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

type Line = Awaited<ReturnType<PrismaClient["vendorOrderLine"]["findMany"]>>[number];
type OrderAgg = {
  orderId: string; orderName: string; createdAt: Date; day: string;
  status: "open" | "shipped" | "cancelled"; detail: "to_ship" | "partly_shipped" | "shipped" | "refunded" | "cancelled";
  net: Decimal; refunded: Decimal; units: number; toShip: number;
};

function aggregate(lines: Line[]): OrderAgg[] {
  const byOrder = new Map<string, Line[]>();
  for (const l of lines) byOrder.set(l.orderId.toString(), [...(byOrder.get(l.orderId.toString()) ?? []), l]);
  return [...byOrder.values()].map((ls) => {
    const live = ls.filter((l) => l.status !== "cancelled");
    const kept = live.filter((l) => l.status !== "refunded");
    const toShip = live.reduce((a, l) => a + Math.max(0, l.currentQuantity - l.fulfilledQuantity), 0);
    const detail = !live.length ? "cancelled"
      : !kept.length ? "refunded"
      : kept.every((l) => l.status === "fulfilled") ? "shipped"
      : kept.some((l) => l.status === "fulfilled" || l.status === "partial") ? "partly_shipped" : "to_ship";
    return {
      orderId: ls[0].orderId.toString(), orderName: ls[0].orderName, createdAt: ls[0].orderCreatedAt, day: istDay(ls[0].orderCreatedAt),
      status: detail === "cancelled" || detail === "refunded" ? "cancelled" : toShip > 0 ? "open" : "shipped",
      detail,
      net: live.reduce((a, l) => a.plus(l.netAmount.toString()), new Decimal(0)),
      refunded: live.reduce((a, l) => a.plus(l.refundedAmount.toString()), new Decimal(0)),
      units: live.reduce((a, l) => a + l.currentQuantity, 0),
      toShip,
    };
  });
}

function totals(orders: OrderAgg[]) {
  const counted = orders.filter((o) => o.status !== "cancelled");
  const net = orders.reduce((a, o) => a.plus(o.net), new Decimal(0));
  return {
    net,
    orders: counted.length,
    units: counted.reduce((a, o) => a + o.units, 0),
    refunded: orders.reduce((a, o) => a.plus(o.refunded), new Decimal(0)),
    aov: counted.length ? net.div(counted.length) : null,
  };
}

const pct = (now: Decimal, before: Decimal) => (before.isZero() ? null : Number(now.minus(before).div(before).times(100).toFixed(1)));

export async function sellerDashboard(db: PrismaClient, scope: VendorScope, range: RangeKey, now = new Date()) {
  const lines = await db.vendorOrderLine.findMany({
    where: { shop: scope.shop, vendorName: scope.vendorName },
    orderBy: [{ orderCreatedAt: "asc" }, { lineItemId: "asc" }],
  });
  const all = aggregate(lines);
  const today = istDay(now);

  // Period and the one before it (same length).
  const days = range === "all" ? null : Number(range);
  const start = days ? addDays(today, -(days - 1)) : null;
  const inRange = (o: OrderAgg) => !start || o.day >= start;
  const current = all.filter(inRange);
  const previous = days ? all.filter((o) => o.day >= addDays(start!, -days) && o.day < start!) : null;
  const t = totals(current);
  const p = previous ? totals(previous) : null;

  // Sales over time: days for 7/30, weeks for 90, months for all time.
  const bucket: "day" | "week" | "month" = range === "all" ? "month" : range === "90" ? "week" : "day";
  const keys: string[] = [];
  if (bucket === "day") for (let i = 0; i < days!; i++) keys.push(addDays(start!, i));
  if (bucket === "week") for (let w = mondayOf(start!); w <= today; w = addDays(w, 7)) keys.push(w);
  if (bucket === "month") {
    const first = all[0]?.day ?? today;
    const cursor = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1));
    const last = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1));
    // At least 6 months on screen, at most the last 24.
    const sixBack = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - 5, 1));
    for (let m = cursor < sixBack ? cursor : sixBack; m <= last; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
      keys.push(m.toISOString().slice(0, 7));
    }
    keys.splice(0, Math.max(0, keys.length - 24));
  }
  const keyOf = (o: OrderAgg) => (bucket === "day" ? o.day : bucket === "week" ? mondayOf(o.day) : o.day.slice(0, 7));
  const sums = new Map(keys.map((k) => [k, { net: new Decimal(0), orders: 0 }]));
  for (const o of current) {
    const s = sums.get(keyOf(o));
    if (!s) continue;
    s.net = s.net.plus(o.net);
    if (o.status !== "cancelled") s.orders++;
  }
  const series = keys.map((k) => {
    const s = sums.get(k)!;
    const label = bucket === "day" ? short(k) : bucket === "week" ? `w/c ${short(k)}` : `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`;
    const full = bucket === "day" ? short(k) + " " + k.slice(0, 4)
      : bucket === "week" ? `Week of ${short(k)} ${k.slice(0, 4)}` : `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
    return { key: k, label, full, net: s.net.toFixed(2), orders: s.orders };
  });

  // Top products in the period, by sales.
  const ids = new Set(current.map((o) => o.orderId));
  const products = new Map<string, { title: string; units: number; net: Decimal }>();
  for (const l of lines) {
    if (!ids.has(l.orderId.toString()) || l.status === "cancelled") continue;
    const key = l.productId?.toString() ?? l.title;
    const p0 = products.get(key) ?? { title: l.title, units: 0, net: new Decimal(0) };
    p0.units += l.currentQuantity;
    p0.net = p0.net.plus(l.netAmount.toString());
    products.set(key, p0);
  }
  const topProducts = [...products.values()]
    .filter((x) => x.net.gt(0) || x.units > 0)
    .sort((a, b) => b.net.comparedTo(a.net) || b.units - a.units)
    .slice(0, 5)
    .map((x) => ({ title: x.title, units: x.units, net: x.net.toFixed(2) }));

  // Right now (not limited to the period).
  const open = all.filter((o) => o.toShip > 0);

  return {
    range, rangeLabel: RANGES[range], today,
    from: start ? istMidnight(start).toISOString() : null,
    hasOrders: all.length > 0,
    sales: { net: t.net.toFixed(2), previous: p ? p.net.toFixed(2) : null, change: p ? pct(t.net, p.net) : null },
    kpis: {
      orders: { value: t.orders, previous: p?.orders ?? null },
      units: { value: t.units, previous: p?.units ?? null },
      aov: { value: t.aov?.toFixed(2) ?? null, previous: p?.aov?.toFixed(2) ?? null },
      refunded: { value: t.refunded.toFixed(2), previous: p ? p.refunded.toFixed(2) : null },
    },
    bucket, series,
    status: {
      shipped: current.filter((o) => o.status === "shipped").length,
      open: current.filter((o) => o.status === "open").length,
      cancelled: current.filter((o) => o.status === "cancelled").length,
    },
    topProducts,
    recent: [...current].reverse().slice(0, 5).map((o) => ({
      orderId: o.orderId, orderName: o.orderName, createdAt: o.createdAt.toISOString(), status: o.detail, units: o.units, net: o.net.toFixed(2),
    })),
    toShip: {
      units: open.reduce((a, o) => a + o.toShip, 0),
      orders: open.length,
      oldest: open.slice(0, 3).map((o) => ({ orderId: o.orderId, orderName: o.orderName, createdAt: o.createdAt.toISOString(), toShip: o.toShip, daysWaiting: Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${o.day}T00:00:00Z`)) / DAY)) })),
    },
  };
}

export type SellerDashboard = Awaited<ReturnType<typeof sellerDashboard>>;
