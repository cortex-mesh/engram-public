-- CreateEnum
CREATE TYPE "AppKey" AS ENUM ('dashboard', 'synapse', 'thoughts');

-- CreateTable
CREATE TABLE "OrgAppEntitlement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "appKey" "AppKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgAppEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgAppEntitlement_orgId_appKey_key" ON "OrgAppEntitlement"("orgId", "appKey");

-- AddForeignKey
ALTER TABLE "OrgAppEntitlement" ADD CONSTRAINT "OrgAppEntitlement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
