-- CreateEnum
CREATE TYPE "VendorRole" AS ENUM ('owner', 'staff');

-- CreateEnum
CREATE TYPE "StaffAccess" AS ENUM ('view', 'edit');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

-- AlterTable
ALTER TABLE "VendorUser" ADD COLUMN     "access" "StaffAccess" NOT NULL DEFAULT 'edit',
ADD COLUMN     "invitedById" TEXT,
ADD COLUMN     "role" "VendorRole" NOT NULL DEFAULT 'owner';

-- CreateTable
CREATE TABLE "VendorChangeRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "requestedById" TEXT,
    "changes" JSONB NOT NULL,
    "status" "ChangeStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorChangeRequest_shop_status_idx" ON "VendorChangeRequest"("shop", "status");

-- CreateIndex
CREATE INDEX "VendorChangeRequest_vendorId_createdAt_idx" ON "VendorChangeRequest"("vendorId", "createdAt");

-- AddForeignKey
ALTER TABLE "VendorChangeRequest" ADD CONSTRAINT "VendorChangeRequest_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorChangeRequest" ADD CONSTRAINT "VendorChangeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "VendorUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

