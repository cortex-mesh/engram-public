import { beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";

/**
 * Integration test setup.
 *
 * Each test file runs against a real PostgreSQL database. Before each file
 * runs, we truncate all app tables so tests see a clean slate.
 *
 * DATABASE_URL must be set to a test database — e.g.:
 *   postgresql://engram_test:engram_test@localhost:5432/engram_test
 *
 * Prerequisites:
 *   - PostgreSQL 16 running on localhost:5432
 *   - engram_test database created and migrated (prisma/migrations applied)
 */

// Ensure we're talking to a *_test database — refuse to run otherwise to
// prevent accidentally wiping dev or prod data.
const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.includes("_test")) {
  throw new Error(
    `Integration tests refuse to run against non-test database. ` +
      `Set DATABASE_URL to a database whose name ends in "_test". ` +
      `Got: ${dbUrl.replace(/\/\/[^@]*@/, "//***@")}`,
  );
}

// Also guard against hitting on-prem-host (production) by accident
if (dbUrl.includes("localhost") || dbUrl.includes("rocky")) {
  throw new Error(
    "Integration tests refuse to run against on-prem-host (production infrastructure)",
  );
}

beforeAll(async () => {
  // Truncate in the right order (cascade handles FKs but explicit is clearer)
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "WaitlistRequest",
      "NativeAuthAuthorizationCode",
      "NativeAuthRedirectUri",
      "NativeAuthClient",
      "RefreshToken",
      "MagicLink",
      "OAuthAccount",
      "EnrollmentConsumerAcknowledgement",
      "EnrollmentSnapshotDelivery",
      "EnrollmentConsumerDelivery",
      "EnrollmentEvent",
      "EnrollmentStream",
      "Enrollment",
      "OrgMember",
      "Organization",
      "User"
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await prisma.$disconnect();
});
