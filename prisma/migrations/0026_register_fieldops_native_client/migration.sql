-- FieldOps (fieldops ADR-003/004/005): register the first-party public PKCE
-- client for FieldOps' dedicated product hosts. FieldOps is a consumer-shape
-- app (Tradepost pattern) that owns its own session; Engram is identity-only.
-- Public client, no secret — the Next.js BFF drives the PKCE flow (S256).
--
-- Dev authenticates directly against login.dev.ctxhost.com with no branded
-- auth host (fieldops ADR-004: no dev-side host-binding mechanism exists).
-- The aws-prod redirect for app.fieldops.club is registered here too so prod
-- promotion needs no second migration; the branded auth host
-- (auth.playfieldops.com) is separate Engram work required by fieldops M4.
--
-- Additive-only (INSERT ... ON CONFLICT upsert), so it auto-passes the suite
-- migration-guard per cortex ADR-128.
INSERT INTO "NativeAuthClient" (
    "id", "clientId", "displayName", "brandName", "brandTagline",
    "enabled", "createdAt", "updatedAt"
)
VALUES (
    'native-client-fieldops-web', 'fieldops-web', 'FieldOps', 'FieldOps',
    'Best ball leagues for people who like drafting.',
    TRUE, NOW(), NOW()
)
ON CONFLICT ("clientId") DO UPDATE
    SET "displayName" = EXCLUDED."displayName",
        "brandName" = EXCLUDED."brandName",
        "brandTagline" = EXCLUDED."brandTagline",
        "enabled" = TRUE,
        "updatedAt" = NOW();

INSERT INTO "NativeAuthRedirectUri" (
    "id", "clientId", "redirectUri", "enabled", "createdAt", "updatedAt"
)
VALUES
    ('native-redirect-fieldops-dev', 'fieldops-web',
     'https://dev.fieldops.club/auth/callback', TRUE, NOW(), NOW()),
    ('native-redirect-fieldops-prod', 'fieldops-web',
     'https://app.fieldops.club/auth/callback', TRUE, NOW(), NOW()),
    ('native-redirect-fieldops-local', 'fieldops-web',
     'http://localhost:3000/auth/callback', TRUE, NOW(), NOW())
ON CONFLICT ("clientId", "redirectUri") DO UPDATE
    SET "enabled" = TRUE,
        "updatedAt" = NOW();
