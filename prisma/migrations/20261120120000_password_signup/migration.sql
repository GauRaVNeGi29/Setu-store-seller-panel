-- Password sign-in and vendor sign-up replace one-time email codes.
-- Existing people keep access: they become "invited" and set a password by signing up
-- with the same email. Existing sessions end (sign-in method changed).

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'pending', 'active', 'rejected', 'disabled');

-- Vendor brand details
ALTER TABLE "Vendor" ADD COLUMN     "city" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "gstNumber" TEXT,
ADD COLUMN     "minimumOrderValue" DECIMAL(12,2),
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "policy" TEXT,
ADD COLUMN     "productNote" TEXT,
ADD COLUMN     "state" TEXT;

-- VendorUser: status + password; carry "active" over before dropping it
ALTER TABLE "VendorUser"
ADD COLUMN     "application" JSONB,
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'invited',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "vendorId" DROP NOT NULL;

UPDATE "VendorUser" SET "status" = CASE WHEN "active" THEN 'invited'::"UserStatus" ELSE 'disabled'::"UserStatus" END;
ALTER TABLE "VendorUser" DROP COLUMN "active";
ALTER TABLE "VendorUser" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Sessions created with codes end now
DELETE FROM "PortalSession";

-- One-time codes are no longer used
DROP TABLE "LoginCode";

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" BIGSERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "vendorUserId" TEXT NOT NULL,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginAttempt_shop_email_createdAt_idx" ON "LoginAttempt"("shop", "email", "createdAt");
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt");
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");
CREATE INDEX "PasswordReset_vendorUserId_idx" ON "PasswordReset"("vendorUserId");
CREATE INDEX "VendorUser_shop_status_idx" ON "VendorUser"("shop", "status");

ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_vendorUserId_fkey" FOREIGN KEY ("vendorUserId") REFERENCES "VendorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
