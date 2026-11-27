import type { PrismaClient } from "@prisma/client";
import { updateStoreListing } from "../storefront/update.server";
import { setReviewHidden } from "./reviews.server";

/**
 * The team hides a review or shows it again, from the Reviews page or from a
 * vendor's page. The rating on the seller's store listing follows.
 */
export async function changeReviewVisibility(
  db: PrismaClient, shop: string, vendorId: string, reviewId: string, hide: boolean, actor: string, reason?: string | null,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const r = await setReviewHidden(db, shop, vendorId, reviewId, hide, actor, reason);
  if (!r.ok) return r;
  const listing = await updateStoreListing(db, shop, vendorId);
  const message = hide ? "Review hidden – no longer counted in the rating" : "Review shown again";
  return listing.ok ? { ok: true, message } : { ok: true, message, error: `The rating on the store listing didn't update: ${listing.error}` };
}
