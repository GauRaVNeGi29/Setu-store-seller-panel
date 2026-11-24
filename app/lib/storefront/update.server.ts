import type { PrismaClient } from "@prisma/client";
import { friendly, syncListing, type ListingResult } from "./listing.server";

/**
 * Updates a vendor's store listing with the app's saved Shopify sign-in for
 * the shop (the offline session), so it also works from the vendor portal,
 * which has no Shopify admin session.
 *
 * Saving in the app never waits on this for long and never fails because of
 * it: the outcome is recorded on the vendor and shown on its page in the app,
 * where the team can run it again.
 */
const TIMEOUT_MS = 20_000;

export async function updateStoreListing(db: PrismaClient, shop: string, vendorId: string): Promise<ListingResult> {
  if (process.env.STORE_LISTING_SYNC === "off") return { ok: false, error: "Store listing updates are switched off (STORE_LISTING_SYNC=off)." };
  let graphql;
  try {
    const { unauthenticated } = await import("../../shopify.server");
    ({ admin: { graphql } } = await unauthenticated.admin(shop));
  } catch (e) {
    const error = friendly(e);
    await db.vendor.updateMany({ where: { id: vendorId, shop }, data: { storeSyncError: error } });
    return { ok: false, error };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<ListingResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "Shopify took too long to answer. The update may still finish – check again in a minute." }), TIMEOUT_MS);
  });
  try {
    return await Promise.race([syncListing(db, graphql, shop, vendorId), slow]);
  } finally {
    clearTimeout(timer);
  }
}

/** Updates every vendor's listing, one at a time. */
export async function updateAllStoreListings(db: PrismaClient, shop: string) {
  const vendors = await db.vendor.findMany({ where: { shop }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } });
  const failed: { name: string; error: string }[] = [];
  let updated = 0;
  for (const v of vendors) {
    const r = await updateStoreListing(db, shop, v.id);
    if (r.ok) updated++;
    else {
      failed.push({ name: v.displayName, error: r.error });
      // A missing permission or sign-in fails every vendor the same way: stop at the first.
      if (/isn't allowed|no saved Shopify sign-in|switched off/.test(r.error)) return { total: vendors.length, updated, failed, stopped: true };
    }
  }
  return { total: vendors.length, updated, failed, stopped: false };
}
