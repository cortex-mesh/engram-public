-- Native OAuth-style public clients for first-party apps using authorization code + PKCE.
CREATE TABLE "NativeAuthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NativeAuthRedirectUri" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAuthRedirectUri_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NativeAuthAuthorizationCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeAuthAuthorizationCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NativeAuthClient_clientId_key" ON "NativeAuthClient"("clientId");
CREATE UNIQUE INDEX "NativeAuthRedirectUri_clientId_redirectUri_key" ON "NativeAuthRedirectUri"("clientId", "redirectUri");
CREATE INDEX "NativeAuthRedirectUri_clientId_idx" ON "NativeAuthRedirectUri"("clientId");
CREATE UNIQUE INDEX "NativeAuthAuthorizationCode_codeHash_key" ON "NativeAuthAuthorizationCode"("codeHash");
CREATE INDEX "NativeAuthAuthorizationCode_clientId_idx" ON "NativeAuthAuthorizationCode"("clientId");
CREATE INDEX "NativeAuthAuthorizationCode_userId_idx" ON "NativeAuthAuthorizationCode"("userId");
CREATE INDEX "NativeAuthAuthorizationCode_expiresAt_idx" ON "NativeAuthAuthorizationCode"("expiresAt");

ALTER TABLE "NativeAuthRedirectUri"
ADD CONSTRAINT "NativeAuthRedirectUri_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "NativeAuthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NativeAuthAuthorizationCode"
ADD CONSTRAINT "NativeAuthAuthorizationCode_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "NativeAuthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NativeAuthAuthorizationCode"
ADD CONSTRAINT "NativeAuthAuthorizationCode_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
