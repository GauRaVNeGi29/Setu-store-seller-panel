import type { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { addDays, aggregate, istDay } from "../portal/dashboard.server";
import { RANGES, type RangeKey } from "../portal/ranges";

/**
 * Commission: one percentage per vendor, set by the Setu Store team.
 *
 * - Taken from the vendor's sales after discounts and refunds (the same
 *   "sales" as My orders and the dashboard), order by order, rounded to the
 *   paisa (half up). Cancelled orders: nothing. Shipping and taxes aren't split
 *   by vendor, so they're not included.
 * - An order uses the rate in force when it was placed. Changing a rate adds a
 *   history row from that moment, so past orders never change. A vendor's very
 *   first rate applies to every order (there was no rate before it).
 * - Not modelled: GST on commission, TCS/TDS, payouts.
 */

export type RateRow = { rate: string; effectiveFrom: string; setBy: string; createdAt: string; fromStart: boolean };
export type CommissionResult = { ok: true; rate: string } | { ok: false; error: string };

const RATE = /^\d{1,3}(\.\d{1,2})?$/;
const START = new Date(0);

export async function commissionHistory(db: PrismaClient, shop: string, vendorId: string): Promise<RateRow[]> {
  const rows = await db.vendorCommission.findMany({ where: { shop, vendorId }, orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }] });
  return rows.map((r) => ({
    rate: r.ratePercent.toFixed(2), effectiveFrom: r.effectiveFrom.toISOString(), setBy: r.setBy.replace(/^admin:/, ""),
    createdAt: r.createdAt.toISOString(), fromStart: r.effectiveFrom.getTime() === START.getTime(),
  }));
}

/** The rate in force at `at` (history oldest first), or null before any rate was set. */
export function rateAt(history: RateRow[], at: Date): string | null {
  let rate: string | null = null;
  for (const h of history) if (Date.parse(h.effectiveFrom) <= at.getTime()) rate = h.rate;
  return rate;
}

export const currentRate = (history: RateRow[]) => (history.length ? history[history.length - 1].rate : null);

/** The team sets or changes a vendor's rate (Shopify admin). */
export async function setCommissionRate(db: PrismaClient, shop: string, vendorId: string, raw: string, actor: string, now = new Date()): Promise<CommissionResult> {
  const value = String(raw ?? "").trim().replace(/%$/, "").trim();
  if (!RATE.test(value) || Number(value) > 100) return { ok: false, error: "Enter a percentage from 0 to 100, with up to 2 decimals, e.g. 12.5." };
  const vendor = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!vendor) return { ok: false, error: "Vendor not found" };
  const history = await commissionHistory(db, shop, vendorId);
  const rate = new Decimal(value).toFixed(2);
  if (currentRate(history) === rate) return { ok: false, error: `The rate is already ${Number(rate)}%.` };
  const effectiveFrom = history.length ? now : START;
  await db.vendorCommission.create({ data: { shop, vendorId, ratePercent: rate, effectiveFrom, setBy: actor.slice(0, 200), createdAt: now } });
  await db.auditLog.create({ data: { shop, actor, action: "vendor.commission_set", target: `vendor:${vendorId}`, detail: { rate, from: history.length ? now.toISOString() : "all orders", previous: currentRate(history) } } });
  return { ok: true, rate };
}

const commissionOn = (net: Decimal, rate: string) => net.times(rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Earnings for a period: one row per order (newest first) with the rate used,
 * the commission and what the vendor earns; plus totals. Vendor from the session only.
 */
export async function vendorEarnings(db: PrismaClient, scope: { shop: string; vendorName: string; vendorId: string }, range: RangeKey, now = new Date()) {
  const [lines, history] = await Promise.all([
    db.vendorOrderLine.findMany({ where: { shop: scope.shop, vendorName: scope.vendorName }, orderBy: [{ orderCreatedAt: "asc" }, { lineItemId: "asc" }] }),
    commissionHistory(db, scope.shop, scope.vendorId),
  ]);
  const today = istDay(now);
  const start = range === "all" ? null : addDays(today, -(Number(range) - 1));
  const orders = aggregate(lines).filter((o) => !start || o.day >= start);

  let net = new Decimal(0), commission = new Decimal(0), withoutRate = 0;
  const rows = orders.reverse().map((o) => {
    const rate = rateAt(history, o.createdAt);
    const c = rate === null ? null : commissionOn(o.net, rate);
    net = net.plus(o.net);
    if (c) commission = commission.plus(c);
    else if (!o.net.isZero()) withoutRate++;
    return {
      orderId: o.orderId, orderName: o.orderName, createdAt: o.createdAt.toISOString(), status: o.detail,
      net: o.net.toFixed(2), rate, commission: c?.toFixed(2) ?? null, earnings: c ? o.net.minus(c).toFixed(2) : null,
    };
  });
  const counted = net.minus(rows.filter((r) => r.commission === null).reduce((a, r) => a.plus(r.net), new Decimal(0)));
  return {
    range, rangeLabel: RANGES[range],
    rate: currentRate(history),
    history: [...history].reverse(),
    rows,
    totals: {
      net: net.toFixed(2),
      commission: commission.toFixed(2),
      /** What the vendor earns on orders that have a rate. */
      earnings: counted.minus(commission).toFixed(2),
      ordersWithoutRate: withoutRate,
    },
  };
}

export type VendorEarnings = Awaited<ReturnType<typeof vendorEarnings>>;
