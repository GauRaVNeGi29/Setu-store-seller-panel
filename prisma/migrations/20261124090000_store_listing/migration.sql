-- The vendor's public listing on the store (marketplace_seller metaobject entry)
ALTER TABLE "Vendor" ADD COLUMN "storeEntryHandle" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "storeSyncedAt" TIMESTAMP(3);
ALTER TABLE "Vendor" ADD COLUMN "storeSyncError" TEXT;

-- Copy of a public brand image in the store's Files
ALTER TABLE "VendorFile" ADD COLUMN "shopifyFileId" TEXT;
