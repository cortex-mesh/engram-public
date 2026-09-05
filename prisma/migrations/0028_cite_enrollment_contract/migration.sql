-- Explicit, client-scoped Cite the Move enrollment state. It is intentionally
-- independent of Nexus organization/membership/entitlement tables.
CREATE TYPE "EnrollmentStatus" AS ENUM ('active', 'revoked', 'expired');

CREATE TABLE "Enrollment" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" TEXT,
  "subjectId" TEXT NOT NULL,
  "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
  "version" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revocationReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Enrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Enrollment_clientId_subjectId_key" ON "Enrollment"("clientId", "subjectId");
CREATE INDEX "Enrollment_clientId_status_expiresAt_idx" ON "Enrollment"("clientId", "status", "expiresAt");

CREATE TABLE "EnrollmentStream" (
  "clientId" TEXT NOT NULL,
  "headSequence" INTEGER NOT NULL DEFAULT 0,
  "retainedFrom" INTEGER NOT NULL DEFAULT 1,
  "headEventId" TEXT,
  "headEventHash" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnrollmentStream_pkey" PRIMARY KEY ("clientId")
);

CREATE TABLE "EnrollmentEvent" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "eventHash" TEXT NOT NULL,
  "previousHash" TEXT,
  "signedJws" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EnrollmentEvent_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EnrollmentEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "EnrollmentStream"("clientId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EnrollmentEvent_eventHash_key" ON "EnrollmentEvent"("eventHash");
CREATE UNIQUE INDEX "EnrollmentEvent_clientId_sequence_key" ON "EnrollmentEvent"("clientId", "sequence");
CREATE INDEX "EnrollmentEvent_clientId_createdAt_idx" ON "EnrollmentEvent"("clientId", "createdAt");
CREATE INDEX "EnrollmentEvent_enrollmentId_sequence_idx" ON "EnrollmentEvent"("enrollmentId", "sequence");

CREATE TABLE "EnrollmentConsumerAcknowledgement" (
  "id" TEXT NOT NULL,
  "consumerId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "headSequence" INTEGER NOT NULL,
  "headEventId" TEXT,
  "headEventHash" TEXT,
  "headJwsHash" TEXT NOT NULL,
  "lastSnapshotJwsHash" TEXT,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnrollmentConsumerAcknowledgement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EnrollmentConsumerAcknowledgement_consumerId_clientId_key" ON "EnrollmentConsumerAcknowledgement"("consumerId", "clientId");

CREATE TABLE "EnrollmentSnapshotDelivery" (
  "id" TEXT NOT NULL,
  "consumerId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "headSequence" INTEGER NOT NULL,
  "headEventId" TEXT,
  "headEventHash" TEXT,
  "snapshotJwsHash" TEXT NOT NULL,
  "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentSnapshotDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EnrollmentSnapshotDelivery_consumerId_clientId_snapshotJwsH_key" ON "EnrollmentSnapshotDelivery"("consumerId", "clientId", "snapshotJwsHash");
CREATE INDEX "EnrollmentSnapshotDelivery_consumerId_clientId_headSequence_idx" ON "EnrollmentSnapshotDelivery"("consumerId", "clientId", "headSequence");

CREATE TABLE "EnrollmentConsumerDelivery" (
  "id" TEXT NOT NULL,
  "consumerId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventHash" TEXT NOT NULL,
  "snapshotJwsHash" TEXT,
  "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentConsumerDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EnrollmentConsumerDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EnrollmentEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EnrollmentConsumerDelivery_consumerId_clientId_sequence_key" ON "EnrollmentConsumerDelivery"("consumerId", "clientId", "sequence");
CREATE INDEX "EnrollmentConsumerDelivery_eventId_idx" ON "EnrollmentConsumerDelivery"("eventId");
