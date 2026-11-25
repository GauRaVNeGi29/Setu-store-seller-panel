-- Country shown with the seller's city on the store
ALTER TABLE "Vendor" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'India';

-- The item a review is about (optional)
ALTER TABLE "VendorReview" ADD COLUMN "productId" BIGINT;
ALTER TABLE "VendorReview" ADD COLUMN "productTitle" TEXT;
