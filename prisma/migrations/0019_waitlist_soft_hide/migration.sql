ALTER TABLE "WaitlistRequest"
  ADD COLUMN "requestCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lastRequestedAt" TIMESTAMP(3),
  ADD COLUMN "hiddenAt" TIMESTAMP(3),
  ADD COLUMN "hiddenByUserId" TEXT,
  ADD COLUMN "hiddenReason" TEXT;

UPDATE "WaitlistRequest"
SET "lastRequestedAt" = "createdAt"
WHERE "lastRequestedAt" IS NULL;

ALTER TABLE "WaitlistRequest"
  ALTER COLUMN "lastRequestedAt" SET NOT NULL,
  ALTER COLUMN "lastRequestedAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "WaitlistRequest_hiddenAt_createdAt_idx" ON "WaitlistRequest"("hiddenAt", "createdAt");
