-- Register Synapse native as a first-party public PKCE client.
-- The custom scheme callback must match the native app's Info.plist URL scheme exactly.
INSERT INTO "NativeAuthClient" (
    "id",
    "clientId",
    "displayName",
    "enabled",
    "createdAt",
    "updatedAt"
)
VALUES (
    'native-client-synapse-native',
    'synapse-native',
    'Synapse Native',
    TRUE,
    NOW(),
    NOW()
)
ON CONFLICT ("clientId") DO UPDATE
    SET "displayName" = EXCLUDED."displayName",
        "enabled" = TRUE,
        "updatedAt" = NOW();

INSERT INTO "NativeAuthRedirectUri" (
    "id",
    "clientId",
    "redirectUri",
    "enabled",
    "createdAt",
    "updatedAt"
)
VALUES (
    'native-redirect-synapse-callback',
    'synapse-native',
    'synapse://auth/engram/callback',
    TRUE,
    NOW(),
    NOW()
)
ON CONFLICT ("clientId", "redirectUri") DO UPDATE
    SET "enabled" = TRUE,
        "updatedAt" = NOW();
