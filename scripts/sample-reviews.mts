/**
 * Sample reviews for the DEVELOPMENT store, so the Reviews pages can be seen
 * before buyers can leave real ones. Every sample says "Sample review" and is
 * shown as from "Sample buyer".
 *
 *   npm run reviews:sample            add three samples to each seller that has a shipped order
 *   npm run reviews:sample -- remove  take all samples out again
 *
 * Refuses to run anywhere but the development store.
 */
import { PrismaClient } from "@prisma/client";
import { eligibleItems, submitReview } from "../app/lib/reviews/reviews.server";

const DEV_SHOP = "seller-panel-dev.myshopify.com";
const shop = process.env.PORTAL_SHOP ?? "";
if (shop !== DEV_SHOP || process.env.NODE_ENV === "production") {
  console.error(`Sample reviews are for the development store only (${DEV_SHOP}). PORTAL_SHOP is "${shop}". Nothing was changed.`);
  process.exit(1);
}

// Samples use buyer numbers below zero, which no real Shopify customer has.
const SAMPLES = [
  // `products`: how many of the seller's shipped products the sample says it is about (shown as pictures on the store).
  { customerId: -1n, rating: 5, comment: "Sample review: beautiful work and carefully packed. Will order again.", products: 3, buyerLocation: { city: "Jaipur", country: "India" } },
  { customerId: -2n, rating: 4, comment: "Sample review: good quality. Delivery took a few days longer than expected.", products: 1, buyerLocation: { city: "Pune", country: "India" } },
  { customerId: -3n, rating: 3, comment: "Sample review: fine overall, but one piece had a small scratch.", products: 0, buyerLocation: null },
];

const db = new PrismaClient();
try {
  if (process.argv[2] === "remove") {
    const gone = await db.vendorReview.deleteMany({ where: { shop, customerId: { lt: 0n } } });
    console.log(`Removed ${gone.count} sample review${gone.count === 1 ? "" : "s"}.`);
  } else {
    const vendors = await db.vendor.findMany({ where: { shop, status: "active" }, orderBy: { displayName: "asc" } });
    if (!vendors.length) console.log("No active sellers in the seller panel yet.");
    for (const v of vendors) {
      const shipped = await db.vendorOrderLine.findMany({
        where: { shop, vendorName: v.vendorName, orderCancelled: false, fulfilledQuantity: { gt: 0 } },
        distinct: ["orderId"], select: { orderId: true },
      });
      if (!shipped.length) {
        console.log(`${v.displayName}: no shipped order yet, so no one could review them. Skipped.`);
        continue;
      }
      let added = 0;
      const orderIds = shipped.map((l) => l.orderId);
      const bought = await eligibleItems(db, shop, v.vendorName, orderIds);
      for (const { products, ...s } of SAMPLES) {
        const r = await submitReview(db, shop, { vendorId: v.id, orderIds, authorName: "Sample buyer", productIds: bought.slice(0, products).map((i) => i.id), ...s });
        if (r.ok) added++;
        else console.log(`${v.displayName}: ${r.error}`);
      }
      console.log(`${v.displayName}: ${added} sample reviews in place.`);
    }
    console.log('Done. See them under Reviews in the seller portal. Remove them with: npm run reviews:sample -- remove');
  }
} finally {
  await db.$disconnect();
}
