import { vi } from "vitest";

export const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  organization: {
    findUnique: vi.fn(),
  },
  orgMember: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  orgAppEntitlement: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  userAppEntitlement: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  waitlistRequest: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  emailSuppression: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  refreshToken: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  nativeAuthClient: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  nativeAuthAuthorizationCode: {
    create: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  enrollment: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  enrollmentStream: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  enrollmentEvent: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  enrollmentConsumerAcknowledgement: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  enrollmentSnapshotDelivery: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  enrollmentConsumerDelivery: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  magicLink: {
    create: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  oAuthAccount: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  auditLog: {
    create: vi.fn().mockResolvedValue({}),
  },
};

// Interactive-transaction shim: runs the callback with mockPrisma as the tx
// client (so tx.<model>.<fn> hits the same mocks); supports the array form too.
// A PLAIN function (not vi.fn) so the per-test `Object.values(mockPrisma)`
// reset loops skip it (Object.values(plainFn) === []).
(mockPrisma as Record<string, unknown>).$transaction = (arg: unknown) =>
  typeof arg === "function"
    ? (arg as (tx: typeof mockPrisma) => unknown)(mockPrisma)
    : Promise.all(arg as unknown[]);

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));
