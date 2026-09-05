-- ADR-031: refresh-token reuse-grace window.
-- Keep a rotated refresh token's row briefly (consumedAt) so a benign
-- concurrent/retry refresh presented within the grace window is graced instead
-- of revoking the whole session family. "replacement" holds the AES-GCM-
-- encrypted successor refresh token so every within-grace caller converges on
-- the SAME successor (one chain, no parallel session). NULL consumedAt = active.
-- Additive + backward-compatible: existing rows default to NULL.
ALTER TABLE "RefreshToken" ADD COLUMN "consumedAt" TIMESTAMP(3);
ALTER TABLE "RefreshToken" ADD COLUMN "replacement" TEXT;

-- Supports the on-rotation sweep of consumed-past-grace rows. The RefreshToken
-- table only holds live/recently-rotated sessions, so this builds ~instantly;
-- on a large table apply CREATE INDEX CONCURRENTLY manually instead.
CREATE INDEX "RefreshToken_consumedAt_idx" ON "RefreshToken"("consumedAt");
