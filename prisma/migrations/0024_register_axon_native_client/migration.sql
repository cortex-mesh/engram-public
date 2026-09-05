-- Axon standalone (axon ADR-038 D10): register the first-party public PKCE
-- client for Axon's dedicated product host (axon.dev.ctxhost.com). The `axon`
-- AppKey already exists (migration 0004). Public client, no secret — the
-- FastAPI backend drives the PKCE flow. Additive-only (INSERT ... ON CONFLICT
-- upsert), so it auto-passes the suite migration-guard.
INSERT INTO "NativeAuthClient" (
    "id", "clientId", "displayName", "enabled", "createdAt", "updatedAt"
)
VALUES (
    'native-client-axon-web', 'axon-web', 'Axon', TRUE, NOW(), NOW()
)
ON CONFLICT ("clientId") DO UPDATE
    SET "displayName" = EXCLUDED."displayName",
        "enabled" = TRUE,
        "updatedAt" = NOW();

INSERT INTO "NativeAuthRedirectUri" (
    "id", "clientId", "redirectUri", "enabled", "createdAt", "updatedAt"
)
VALUES
    ('native-redirect-axon-dev', 'axon-web',
     'https://axon.dev.ctxhost.com/auth/callback', TRUE, NOW(), NOW()),
    ('native-redirect-axon-local', 'axon-web',
     'http://localhost:3103/auth/callback', TRUE, NOW(), NOW()),
    ('native-redirect-axon-onprem', 'axon-web',
     'https://lab.rapidagent.dev:8443/axon/auth/callback', TRUE, NOW(), NOW())
ON CONFLICT ("clientId", "redirectUri") DO UPDATE
    SET "enabled" = TRUE,
        "updatedAt" = NOW();
