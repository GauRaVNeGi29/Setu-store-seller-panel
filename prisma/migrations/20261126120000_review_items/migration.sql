-- A review can be about several of the products the buyer bought from the seller
CREATE TABLE "VendorReviewItem" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "productId" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VendorReviewItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VendorReviewItem_reviewId_productId_key" ON "VendorReviewItem"("reviewId", "productId");
CREATE INDEX "VendorReviewItem_productId_idx" ON "VendorReviewItem"("productId");
ALTER TABLE "VendorReviewItem" ADD CONSTRAINT "VendorReviewItem_reviewId_fkey"
  FOREIGN KEY ("reviewId") REFERENCES "VendorReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reviews that named one item keep it. The old columns stay for now (older
-- branches still read them) but are no longer written.
INSERT INTO "VendorReviewItem" ("id", "reviewId", "productId", "title", "position")
SELECT 'ri_' || "id", "id", "productId", COALESCE("productTitle", ''), 0
FROM "VendorReview" WHERE "productId" IS NOT NULL;
