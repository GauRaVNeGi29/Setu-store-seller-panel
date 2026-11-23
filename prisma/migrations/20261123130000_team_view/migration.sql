-- AlterTable
ALTER TABLE "PortalSession" ADD COLUMN     "teamViewer" TEXT;

-- CreateTable
CREATE TABLE "PortalHandoff" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "vendorUserId" TEXT NOT NULL,
    "teamViewer" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalHandoff_tokenHash_key" ON "PortalHandoff"("tokenHash");

-- CreateIndex
CREATE INDEX "PortalHandoff_vendorUserId_idx" ON "PortalHandoff"("vendorUserId");

-- AddForeignKey
ALTER TABLE "PortalHandoff" ADD CONSTRAINT "PortalHandoff_vendorUserId_fkey" FOREIGN KEY ("vendorUserId") REFERENCES "VendorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

