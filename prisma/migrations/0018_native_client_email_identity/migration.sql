-- Wave 21: per-client email identity for branded auth mail.
-- Nullable fields preserve the suite default: CORTEX through the configured
-- verified sender. Tradepost records the desired production sender, but app
-- code falls back to the verified EMAIL_FROM domain until ccgtradepost.com is
-- verified in Resend.
ALTER TABLE "NativeAuthClient"
ADD COLUMN "emailFromName" TEXT,
ADD COLUMN "emailFromAddress" TEXT,
ADD COLUMN "emailTemplateTheme" TEXT;

UPDATE "NativeAuthClient"
SET
  "brandName" = 'CCG Tradepost',
  "displayName" = 'CCG Tradepost',
  "brandTagline" = 'Collection tracking, deck building, and trading for Magic players.',
  "emailFromName" = 'CCG Tradepost',
  "emailFromAddress" = 'noreply@ccgtradepost.com',
  "emailTemplateTheme" = 'tradepost',
  "updatedAt" = NOW()
WHERE "clientId" = 'tradepost-web';
