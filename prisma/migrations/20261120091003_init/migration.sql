-- CreateEnum
CREATE TYPE "LineStatus" AS ENUM ('unfulfilled', 'partial', 'fulfilled', 'refunded', 'cancelled');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorOrderLine" (
    "shop" TEXT NOT NULL,
    "lineItemId" BIGINT NOT NULL,
    "orderId" BIGINT NOT NULL,
    "orderName" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "productId" BIGINT,
    "variantId" BIGINT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "currentQuantity" INTEGER NOT NULL,
    "refundedQuantity" INTEGER NOT NULL DEFAULT 0,
    "fulfilledQuantity" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "refundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "status" "LineStatus" NOT NULL,
    "orderCancelled" BOOLEAN NOT NULL DEFAULT false,
    "financialStatus" TEXT NOT NULL,
    "fulfillmentStatus" TEXT NOT NULL,
    "orderCreatedAt" TIMESTAMP(3) NOT NULL,
    "orderUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorOrderLine_pkey" PRIMARY KEY ("shop","lineItemId")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "shop" TEXT NOT NULL,
    "lastFullSyncAt" TIMESTAMP(3),
    "lastFullSyncCount" INTEGER,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorOrderLine_shop_vendorName_orderCreatedAt_idx" ON "VendorOrderLine"("shop", "vendorName", "orderCreatedAt");

-- CreateIndex
CREATE INDEX "VendorOrderLine_shop_orderId_idx" ON "VendorOrderLine"("shop", "orderId");

-- CreateIndex
CREATE INDEX "AuditLog_shop_at_idx" ON "AuditLog"("shop", "at");
