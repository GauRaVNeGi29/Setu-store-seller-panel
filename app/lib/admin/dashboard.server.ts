import type { PrismaClient } from "@prisma/client";
import { recentActivity, storeTotals, vendorOverview } from "../orders/admin.server";
import { reviewNumbers } from "../reviews/reviews.server";
import { deliveryTime } from "../settings/settings.server";
import { listAllVendors } from "../vendors/team.server";
import { listSignups } from "../vendors/vendors.server";
import { mailNumbers } from "../mail/admin.server";

/**
 * What the app's Dashboard shows: alerts (each one says where to deal with
 * it), a few numbers for each area of the app, and a short sales report.
 */

export type Alert = {
  key: string;
  /** critical: something is broken. warning: something is waiting for the team. */
  tone: "critical" | "warning";
  text: string;
  /** Where in the app this is dealt with. */
  href: string;
  /** The vendors concerned, when the alert is about particular vendors. */
  vendors?: { name: string; vendorName: string }[];
};

const REPORT_DAYS = 30;

export async function dashboard(db: PrismaClient, shop: string, now = new Date()) {
  const since = new Date(now.getTime() - REPORT_DAYS * 24 * 60 * 60 * 1000);
  const [vendors, signups, delivery, allTime, period, reviews, activity, mail] = await Promise.all([
    listAllVendors(db, shop),
    listSignups(db, shop),
    deliveryTime(db, shop),
    vendorOverview(db, shop),
    vendorOverview(db, shop, since),
    reviewNumbers(db, shop, now),
    recentActivity(db, shop, 8, true),
    mailNumbers(db, shop, now),
  ]);

  const alerts: Alert[] = [];
  const about = (key: string, list: typeof vendors, one: string, many: string) => {
    if (!list.length) return;
    alerts.push({
      key, tone: "warning", href: "/app/vendors?view=attention",
      text: `${list.length} ${list.length === 1 ? one : many}`,
      vendors: list.map((v) => ({ name: v.displayName, vendorName: v.vendorName })),
    });
  };
  if (allTime.lastError) alerts.push({ key: "sync", tone: "critical", href: "/app/orders", text: `Orders didn't copy from Shopify: ${allTime.lastError}` });
  if (delivery.error) alerts.push({ key: "delivery_copy", tone: "critical", href: "/app/orders", text: "The delivery time is saved here but the store doesn't show it yet" });
  else if (!delivery.range) alerts.push({ key: "delivery_unset", tone: "warning", href: "/app/orders", text: "No delivery time is set, so seller pages show no arrival dates" });
  if (mail.failed) alerts.push({ key: "mail_failed", tone: "critical", href: "/app/mail?view=log&status=failed", text: `${mail.failed} ${mail.failed === 1 ? "mail" : "mails"} couldn't be sent in the last 7 days` });
  if (mail.bounced) alerts.push({ key: "mail_bounced", tone: "warning", href: "/app/mail?view=log&status=bounced", text: `${mail.bounced} ${mail.bounced === 1 ? "mail was" : "mails were"} refused by the address in the last 7 days` });
  if (!mail.team.length) alerts.push({ key: "mail_no_team", tone: "warning", href: "/app/mail?view=team", text: "No team address is set, so nobody on the team gets alert mails" });
  if (signups.length) alerts.push({ key: "signups", tone: "warning", href: "/app/signups", text: `${signups.length} ${signups.length === 1 ? "sign-up is" : "sign-ups are"} waiting for approval` });
  about("business_changes", vendors.filter((v) => v.pendingChange), "vendor has business changes to review", "vendors have business changes to review");
  about("no_commission", vendors.filter((v) => v.commission === null), "vendor has no commission rate", "vendors have no commission rate");
  about("no_processing_time", vendors.filter((v) => !v.processing), "vendor hasn't given a processing time", "vendors haven't given a processing time");
  about("missing_details", vendors.filter((v) => v.missing.length > 0), "vendor has details missing", "vendors have details missing");
  about("store_listing", vendors.filter((v) => v.store !== "ok"), "vendor's store listing isn't up to date", "vendors' store listings aren't up to date");

  const all = storeTotals(allTime.vendors);
  const recent = storeTotals(period.vendors);
  const nameOf = new Map(vendors.map((v) => [v.vendorName, v.displayName]));
  return {
    alerts,
    numbers: {
      vendors: { total: vendors.length, active: vendors.filter((v) => v.status === "active").length, paused: vendors.filter((v) => v.status !== "active").length, signups: signups.length },
      shipping: { unitsToShip: all.unitsToShip, vendorsToShip: all.vendorsToShip, openOrders: allTime.vendors.reduce((n, v) => n + v.openOrders, 0) },
      orders: { total: allTime.orderCount, net: all.net },
      reviews: { published: reviews.published, hidden: reviews.hidden, average: reviews.average, last30Days: reviews.last30Days },
      mail: { sent: mail.sent, waiting: mail.waiting, failed: mail.failed, bounced: mail.bounced },
    },
    report: {
      days: REPORT_DAYS,
      orders: period.orderCount, units: recent.units, net: recent.net,
      /** The five vendors that sold most in the period. */
      topVendors: [...period.vendors].filter((v) => Number(v.net) > 0).sort((a, b) => Number(b.net) - Number(a.net)).slice(0, 5)
        .map((v) => ({ vendorName: v.vendorName, name: nameOf.get(v.vendorName) ?? v.vendorName, orders: v.orders, units: v.units, net: v.net })),
    },
    delivery,
    lastFullSyncAt: allTime.lastFullSyncAt,
    activity,
  };
}
