-- Tradepost (ADR-018): add the app key and register the first-party public
-- PKCE client for the dedicated product host (tradepost ADR-003).
ALTER TYPE "AppKey" ADD VALUE IF NOT EXISTS 'tradepost';

INSERT INTO "NativeAuthClient" (
    "id", "clientId", "displayName", "enabled", "createdAt", "updatedAt"
)
VALUES (
    'native-client-tradepost-web', 'tradepost-web', 'Tradepost', TRUE, NOW(), NOW()
)
ON CONFLICT ("clientId") DO UPDATE
    SET "displayName" = EXCLUDED."displayName",
        "enabled" = TRUE,
        "updatedAt" = NOW();

INSERT INTO "NativeAuthRedirectUri" (
    "id", "clientId", "redirectUri", "enabled", "createdAt", "updatedAt"
)
VALUES
    ('native-redirect-tradepost-dev', 'tradepost-web',
     'https://tradepost.dev.ctxhost.com/auth/callback', TRUE, NOW(), NOW()),
    ('native-redirect-tradepost-prod', 'tradepost-web',
     'https://tradepost.ctxhost.com/auth/callback', TRUE, NOW(), NOW()),
    ('native-redirect-tradepost-local', 'tradepost-web',
     'http://localhost:3000/auth/callback', TRUE, NOW(), NOW())
ON CONFLICT ("clientId", "redirectUri") DO UPDATE
    SET "enabled" = TRUE,
        "updatedAt" = NOW();
