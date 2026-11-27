import type { PrismaClient } from "@prisma/client";
import { vendorOverview } from "../orders/admin.server";
import { listAllVendors } from "../vendors/team.server";
import { listSignups } from "../vendors/vendors.server";

type Listed = Awaited<ReturnType<typeof listAllVendors>>[number];

/** What the team has to do for a vendor, as short labels. Empty when there is nothing. */
export function flagsOf(v: Listed): string[] {
  return [
    v.pendingChange && "Business change to review",
    v.needsApproval > 0 && `${v.needsApproval} requires approval`,
    v.owners.length === 0 && "No owner",
    v.commission === null && "Commission not set",
    !v.processing && "No processing time",
    v.missing.length > 0 && `Missing: ${v.missing.join(", ")}`,
    v.store === "error" && "Store listing didn't update",
    v.store === "never" && "Not on the store yet",
    v.invited > 0 && `${v.invited} invited, no password yet`,
  ].filter(Boolean) as string[];
}

/**
 * The vendors, the order totals, the Shopify vendors that have orders but no
 * portal account, and the numbers shown on the Vendors tabs (also used by the
 * Sign-ups page, which shares those tabs).
 */
export async function vendorCounts(db: PrismaClient, shop: string) {
  const [vendors, signups, overview] = await Promise.all([listAllVendors(db, shop), listSignups(db, shop), vendorOverview(db, shop)]);
  const withAccess = new Set(vendors.map((v) => v.vendorName));
  const noAccess = overview.vendors.filter((v) => v.vendorName && !withAccess.has(v.vendorName));
  return {
    vendors, overview, noAccess,
    counts: { all: vendors.length, attention: vendors.filter((v) => flagsOf(v).length > 0).length, signups: signups.length, noAccess: noAccess.length },
  };
}
