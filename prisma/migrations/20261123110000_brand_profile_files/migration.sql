-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('gst', 'iec', 'ad_code', 'logo', 'banner');

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "adCodeFileId" TEXT,
ADD COLUMN     "addressLine" TEXT,
ADD COLUMN     "bannerFileId" TEXT,
ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "gstFileId" TEXT,
ADD COLUMN     "iecFileId" TEXT,
ADD COLUMN     "logoFileId" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "shortDescription" TEXT;

-- CreateTable
CREATE TABLE "VendorFile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" "FileKind" NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorFile_vendorId_kind_idx" ON "VendorFile"("vendorId", "kind");

-- AddForeignKey
ALTER TABLE "VendorFile" ADD CONSTRAINT "VendorFile_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

