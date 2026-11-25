-- Days a vendor needs to make or ready an order (a range)
ALTER TABLE "Vendor" ADD COLUMN "processingDaysMin" INTEGER;
ALTER TABLE "Vendor" ADD COLUMN "processingDaysMax" INTEGER;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_processingDays_check"
  CHECK (("processingDaysMin" IS NULL AND "processingDaysMax" IS NULL)
      OR ("processingDaysMin" >= 0 AND "processingDaysMax" >= "processingDaysMin" AND "processingDaysMax" <= 365));

-- Settings the team changes in the Shopify app
CREATE TABLE "ShopSetting" (
    "shop" TEXT NOT NULL,
    "deliveryDaysMin" INTEGER,
    "deliveryDaysMax" INTEGER,
    "deliveryError" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSetting_pkey" PRIMARY KEY ("shop"),
    CONSTRAINT "ShopSetting_deliveryDays_check"
      CHECK (("deliveryDaysMin" IS NULL AND "deliveryDaysMax" IS NULL)
          OR ("deliveryDaysMin" >= 0 AND "deliveryDaysMax" >= "deliveryDaysMin" AND "deliveryDaysMax" <= 365))
);
