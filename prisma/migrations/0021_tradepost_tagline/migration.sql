-- Punchier Tradepost login tagline (Roland, 2026-07-20).
-- Replaces the feature-list tagline with the brand line shown under the
-- wordmark on login/register and in page metadata.
UPDATE "NativeAuthClient"
SET "brandTagline" = 'Because “somewhere in a box” isn’t a location.'
WHERE "clientId" = 'tradepost-web';
