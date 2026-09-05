-- Phase 2 (ADR-025 D7): native-client branding, provider policy, signup mode,
-- and client-tagged waitlist enrichment. Defaults preserve existing suite
-- behavior: waitlist-gated signup and both configured OAuth providers.
CREATE TYPE "SignupMode" AS ENUM ('waitlist', 'open');

ALTER TABLE "NativeAuthClient"
ADD COLUMN "brandName" TEXT,
ADD COLUMN "brandTagline" TEXT,
ADD COLUMN "brandLogoUrl" TEXT,
ADD COLUMN "brandPrimaryColor" TEXT,
ADD COLUMN "authProviders" TEXT[] NOT NULL DEFAULT ARRAY['google', 'github']::TEXT[],
ADD COLUMN "signupMode" "SignupMode" NOT NULL DEFAULT 'waitlist';

ALTER TABLE "WaitlistRequest"
ADD COLUMN "clientId" TEXT,
ADD COLUMN "collectionSizeBracket" TEXT,
ADD COLUMN "formatsPlayed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "tradepostGoals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "priorityNote" TEXT,
ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "approvedByUserId" TEXT,
ADD COLUMN "approvalEmailSentAt" TIMESTAMP(3);

CREATE INDEX "WaitlistRequest_clientId_createdAt_idx" ON "WaitlistRequest"("clientId", "createdAt");

UPDATE "NativeAuthClient"
SET
  "brandName" = 'Tradepost',
  "brandTagline" = 'Collection tracking, deck building, and trading for Magic players.',
  "brandPrimaryColor" = '#2563eb',
  "authProviders" = ARRAY['google']::TEXT[],
  "signupMode" = 'waitlist',
  "updatedAt" = NOW()
WHERE "clientId" = 'tradepost-web';

-- Grandfather pre-verification password accounts rather than locking them out.
-- These rows predate the mandatory email-verification login gate and were
-- created through trusted admin or seed paths; new password accounts created
-- after this migration must prove email control before activation.
UPDATE "User"
SET "emailVerified" = TRUE,
    "updatedAt" = NOW()
WHERE "passwordHash" IS NOT NULL
  AND "emailVerified" = FALSE;
