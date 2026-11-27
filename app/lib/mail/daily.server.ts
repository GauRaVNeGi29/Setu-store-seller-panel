import type { PrismaClient } from "@prisma/client";
import { dayKey, teamAddresses } from "./notify.server";
import { queueMail } from "./queue.server";
import { LOG_KEPT_DAYS } from "./rules";

/**
 * Checks that run once a day (from 9 in the morning, India time): orders that
 * still have units to ship after the processing time their vendor gave.
 * Each vendor is reminded once for each such order; the team gets one list.
 */

const DAY = 24 * 60 * 60 * 1000;
const istHour = (now: Date) => new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();

export async function overdueOrders(db: PrismaClient, shop: string, now = new Date()) {
  const vendors = await db.vendor.findMany({
    where: { shop, status: "active", processingDaysMax: { not: null } },
    select: { id: true, vendorName: true, displayName: true, processingDaysMax: true, users: { where: { status: "active" }, select: { email: true, name: true } } },
  });
  const out: { vendorId: string; brand: string; people: { email: string; name: string | null }[]; orderId: bigint; orderName: string; days: number; units: number }[] = [];
  for (const v of vendors) {
    const cutoff = new Date(now.getTime() - v.processingDaysMax! * DAY);
    const lines = await db.vendorOrderLine.findMany({
      where: { shop, vendorName: v.vendorName, orderCancelled: false, orderCreatedAt: { lt: cutoff }, status: { in: ["unfulfilled", "partial"] } },
      select: { orderId: true, orderName: true, orderCreatedAt: true, currentQuantity: true, fulfilledQuantity: true },
    });
    const byOrder = new Map<string, { orderId: bigint; orderName: string; at: Date; units: number }>();
    for (const l of lines) {
      const left = Math.max(0, l.currentQuantity - l.fulfilledQuantity);
      if (!left) continue;
      const o = byOrder.get(l.orderId.toString()) ?? { orderId: l.orderId, orderName: l.orderName, at: l.orderCreatedAt, units: 0 };
      o.units += left;
      byOrder.set(l.orderId.toString(), o);
    }
    for (const o of byOrder.values()) {
      out.push({ vendorId: v.id, brand: v.displayName || v.vendorName, people: v.users, orderId: o.orderId, orderName: o.orderName, days: Math.floor((now.getTime() - o.at.getTime()) / DAY), units: o.units });
    }
  }
  return out.sort((a, b) => b.days - a.days);
}

/** Runs the day's checks for a shop if they haven't run today. Returns whether they ran. */
export async function runDailyChecks(db: PrismaClient, shop: string, now = new Date(), opts: { anyHour?: boolean } = {}): Promise<boolean> {
  if (!opts.anyHour && istHour(now) < 9) return false;
  const today = dayKey(now);
  const setting = await db.shopSetting.findUnique({ where: { shop }, select: { dailyMailOn: true } });
  if (setting?.dailyMailOn === today) return false;
  // Claim the day first, so two runs at once can't both send.
  await db.shopSetting.upsert({ where: { shop }, create: { shop, dailyMailOn: today }, update: { dailyMailOn: today } });

  // The log keeps half a year.
  await db.mailMessage.deleteMany({ where: { shop, createdAt: { lt: new Date(now.getTime() - LOG_KEPT_DAYS * DAY) } } });

  const overdue = await overdueOrders(db, shop, now);
  for (const o of overdue) {
    await queueMail(db, shop, "order_overdue", o.people, { brand: o.brand, orderName: o.orderName, orderId: o.orderId.toString(), days: o.days, units: o.units },
      { vendorId: o.vendorId, dedupe: `order_overdue:${o.orderId}:${o.vendorId}` });
  }
  if (overdue.length) {
    await queueMail(db, shop, "admin_orders_overdue", await teamAddresses(db, shop), { rows: overdue.map((o) => ({ brand: o.brand, orderName: o.orderName, days: o.days, units: o.units })) },
      { dedupe: `admin_orders_overdue:${today}` });
  }
  return true;
}

let clock: ReturnType<typeof setInterval> | null = null;

/** Starts the hourly check for every shop that has vendors. Called once when the server starts. */
export function startMailClock(db: PrismaClient, env: Record<string, string | undefined> = process.env) {
  if (clock || env.NODE_ENV === "test" || env.VITEST || process.env.VITEST) return;
  const tick = async () => {
    try {
      const shops = await db.vendor.findMany({ select: { shop: true }, distinct: ["shop"] });
      for (const { shop } of shops) await runDailyChecks(db, shop);
    } catch (e) {
      console.error("[mail] daily checks failed:", e);
    }
  };
  clock = setInterval(tick, 30 * 60 * 1000);
  clock.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}
