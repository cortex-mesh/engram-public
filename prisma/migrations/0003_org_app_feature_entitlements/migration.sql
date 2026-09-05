-- CreateTable
CREATE TABLE "OrgAppFeatureEntitlement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "appKey" "AppKey" NOT NULL,
    "featureKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgAppFeatureEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgAppFeatureEntitlement_orgId_appKey_featureKey_key" ON "OrgAppFeatureEntitlement"("orgId", "appKey", "featureKey");

-- AddForeignKey
ALTER TABLE "OrgAppFeatureEntitlement" ADD CONSTRAINT "OrgAppFeatureEntitlement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgAppFeatureEntitlement" ADD CONSTRAINT "OrgAppFeatureEntitlement_orgId_appKey_fkey" FOREIGN KEY ("orgId", "appKey") REFERENCES "OrgAppEntitlement"("orgId", "appKey") ON DELETE CASCADE ON UPDATE CASCADE;
