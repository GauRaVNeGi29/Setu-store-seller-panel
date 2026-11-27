-- Mail: every message the app sends (or would send), the on/off switch for each kind, and who on the team gets team mails
CREATE TYPE "MailStatus" AS ENUM ('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed', 'logged');

CREATE TABLE "MailMessage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "vendorId" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "linkLabel" TEXT,
    "linkUrl" TEXT,
    "status" "MailStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "providerId" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MailMessage_shop_dedupeKey_key" ON "MailMessage"("shop", "dedupeKey");
CREATE INDEX "MailMessage_shop_createdAt_idx" ON "MailMessage"("shop", "createdAt");
CREATE INDEX "MailMessage_status_nextAttemptAt_idx" ON "MailMessage"("status", "nextAttemptAt");
CREATE INDEX "MailMessage_providerId_idx" ON "MailMessage"("providerId");

CREATE TABLE "MailTemplateSetting" (
    "shop" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailTemplateSetting_pkey" PRIMARY KEY ("shop", "template")
);

ALTER TABLE "ShopSetting" ADD COLUMN "adminEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ShopSetting" ADD COLUMN "dailyMailOn" TEXT;
