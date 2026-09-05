-- Email hygiene for ADR-026 follow-up: provider suppression state plus
-- waitlist-visible validation status. This migration requires Roland approval
-- under ADR-128 before merge.
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT,
    "providerMessageId" TEXT,
    "rawEvent" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");
CREATE INDEX "EmailSuppression_reason_updatedAt_idx" ON "EmailSuppression"("reason", "updatedAt");

ALTER TABLE "WaitlistRequest"
ADD COLUMN "emailHygieneStatus" TEXT NOT NULL DEFAULT 'accepted',
ADD COLUMN "emailHygieneReason" TEXT,
ADD COLUMN "emailHygieneCheckedAt" TIMESTAMP(3),
ADD COLUMN "confirmationEmailSuppressedAt" TIMESTAMP(3);

CREATE INDEX "WaitlistRequest_emailHygieneStatus_createdAt_idx" ON "WaitlistRequest"("emailHygieneStatus", "createdAt");
