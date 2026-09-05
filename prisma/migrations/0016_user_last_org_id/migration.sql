-- Track the most recently used org per user so post-login routing can send
-- them back to the same tenant they were last on (ADR-024).
-- Nullable FK to Organization; ON DELETE SET NULL so deleting an org never
-- blocks and silently clears the hint for affected users.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastOrgId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_lastOrgId_fkey"
  FOREIGN KEY ("lastOrgId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
