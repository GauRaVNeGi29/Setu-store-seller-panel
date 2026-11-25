-- Buyers' ratings of vendors
CREATE TYPE "ReviewStatus" AS ENUM ('published', 'hidden');

CREATE TABLE "VendorReview" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "customerId" BIGINT NOT NULL,
    "orderId" BIGINT NOT NULL,
    "orderName" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'published',
    "hiddenBy" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "hiddenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VendorReview_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX "VendorReview_shop_vendorId_customerId_key" ON "VendorReview"("shop", "vendorId", "customerId");
CREATE INDEX "VendorReview_shop_vendorId_status_createdAt_idx" ON "VendorReview"("shop", "vendorId", "status", "createdAt");

ALTER TABLE "VendorReview" ADD CONSTRAINT "VendorReview_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
