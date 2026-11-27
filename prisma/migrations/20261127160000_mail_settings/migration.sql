-- Mail settings entered in the app (Mail → Settings). Development first; nothing here touches a store.
CREATE TABLE "MailSetting" (
    "shop" TEXT NOT NULL,
    "apiKeyEnc" TEXT,
    "apiKeyHint" TEXT,
    "fromName" TEXT,
    "fromAddress" TEXT,
    "replyTo" TEXT,
    "onlyTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "webhookSecretEnc" TEXT,
    "webhookSecretHint" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailSetting_pkey" PRIMARY KEY ("shop")
);
