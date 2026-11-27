-- Up to five short tags the seller picks to say what the brand stands for
ALTER TABLE "Vendor" ADD COLUMN "brandValues" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_brandValues_check" CHECK (cardinality("brandValues") <= 5);
