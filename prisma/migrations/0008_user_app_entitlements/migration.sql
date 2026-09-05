-- CreateTable
CREATE TABLE "UserAppEntitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "appKey" "AppKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAppEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAppEntitlement_userId_orgId_appKey_key" ON "UserAppEntitlement"("userId", "orgId", "appKey");

-- CreateIndex
CREATE INDEX "UserAppEntitlement_orgId_appKey_idx" ON "UserAppEntitlement"("orgId", "appKey");

-- AddForeignKey
ALTER TABLE "UserAppEntitlement" ADD CONSTRAINT "UserAppEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAppEntitlement" ADD CONSTRAINT "UserAppEntitlement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
