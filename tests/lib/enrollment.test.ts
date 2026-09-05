import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

import { mockPrisma } from "../mocks/prisma";
import {
  EnrollmentInputError,
  grantEnrollment,
  revokeEnrollment,
} from "@/lib/enrollment";

const ORIGINAL_ENV = { ...process.env };

describe("Cite enrollment mutations", () => {
  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    process.env.ENGRAM_ENROLLMENT_SIGNING_KEY_ID = "test-cite-key";
    process.env.ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY =
      await exportPKCS8(privateKey);
    process.env.ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY =
      await exportSPKI(publicKey);
    process.env.ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE =
      "2026-01-01T00:00:00.000Z";
    process.env.ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER =
      "2027-01-01T00:00:00.000Z";
  });

  afterAll(() => {
    vi.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    for (const model of Object.values(mockPrisma)) {
      for (const fn of Object.values(model))
        (fn as ReturnType<typeof vi.fn>).mockReset?.();
    }
    mockPrisma.enrollmentStream.upsert.mockResolvedValue({
      headSequence: 0,
      headEventHash: null,
    });
    mockPrisma.enrollmentEvent.create.mockResolvedValue({});
    mockPrisma.enrollmentStream.update.mockResolvedValue({});
  });

  it("creates an explicit Axon-only invitation enrollment event without inferring Nexus state", async () => {
    mockPrisma.enrollment.findUnique.mockResolvedValue(null);
    mockPrisma.enrollment.create.mockResolvedValue({
      id: "enrollment-1",
      clientId: "axon-web",
      userId: "invited-user",
      status: "active",
      version: 1,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      revokedAt: null,
      revocationReason: null,
    });
    const result = await grantEnrollment({
      userId: "invited-user",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(result.idempotent).toBe(false);
    expect(mockPrisma.enrollment.create).toHaveBeenCalledWith({
      data: {
        clientId: "axon-web",
        userId: "invited-user",
        subjectId: "invited-user",
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    expect(mockPrisma.enrollmentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: "axon-web",
          sequence: 1,
          kind: "enrollment.granted",
          previousHash: null,
        }),
      }),
    );
    expect(mockPrisma.orgMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.orgAppEntitlement.findUnique).not.toHaveBeenCalled();
  });

  it("does not issue an enrollment or an event for an expired invitation", async () => {
    await expect(
      grantEnrollment({
        userId: "uninvited-user",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(EnrollmentInputError);
    expect(mockPrisma.enrollment.create).not.toHaveBeenCalled();
    expect(mockPrisma.enrollmentEvent.create).not.toHaveBeenCalled();
  });

  it("refuses an enrollment beyond the library's 90-day maximum before persisting state", async () => {
    await expect(
      grantEnrollment({
        userId: "overlong-user",
        expiresAt: new Date("2026-11-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(EnrollmentInputError);
    expect(mockPrisma.enrollment.create).not.toHaveBeenCalled();
    expect(mockPrisma.enrollmentEvent.create).not.toHaveBeenCalled();
  });

  it("turns revocation into the next signed sequence rather than deleting or silently succeeding", async () => {
    mockPrisma.enrollment.findUnique.mockResolvedValue({
      id: "enrollment-1",
      clientId: "axon-web",
      userId: "revoked-user",
      status: "active",
      version: 1,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      revokedAt: null,
      revocationReason: null,
    });
    mockPrisma.enrollment.update.mockResolvedValue({
      id: "enrollment-1",
      clientId: "axon-web",
      userId: "revoked-user",
      status: "revoked",
      version: 2,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      revokedAt: new Date("2026-07-29T00:00:00.000Z"),
      revocationReason: "operator request",
    });
    const result = await revokeEnrollment({
      userId: "revoked-user",
      reason: "operator request",
    });
    expect(result.idempotent).toBe(false);
    expect(mockPrisma.enrollmentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "enrollment.revoked",
          sequence: 1,
        }),
      }),
    );
  });
});
