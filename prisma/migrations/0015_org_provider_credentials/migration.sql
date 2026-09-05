-- Per-org AI provider credentials (ADR-021). Additive-only; no existing data touched.

-- CreateEnum
CREATE TYPE "AiProviderKey" AS ENUM ('anthropic_api', 'codex', 'kimi', 'openclaw', 'hermes');

-- CreateEnum
CREATE TYPE "ProviderCredentialStatus" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "OrgProviderCredential" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "AiProviderKey" NOT NULL,
    "credentialKind" TEXT NOT NULL DEFAULT 'aws_secrets_manager',
    "credentialRef" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "status" "ProviderCredentialStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,

    CONSTRAINT "OrgProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgProviderCredential_orgId_idx" ON "OrgProviderCredential"("orgId");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "OrgProviderCredential_orgId_provider_key" ON "OrgProviderCredential"("orgId", "provider");

-- AddForeignKey
ALTER TABLE "OrgProviderCredential" ADD CONSTRAINT "OrgProviderCredential_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
