import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUserFindUnique } = vi.hoisted(() => ({
  mockUserFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockUserFindUnique } },
}));

import { isCurrentPlatformSuperadmin } from "@/lib/auth";

describe("isCurrentPlatformSuperadmin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when the DB role is SUPERADMIN", async () => {
    mockUserFindUnique.mockResolvedValue({ role: "SUPERADMIN" });
    expect(await isCurrentPlatformSuperadmin({ userId: "u1" })).toBe(true);
    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { role: true },
    });
  });

  it("returns false when the DB role is no longer SUPERADMIN (demoted)", async () => {
    // The JWT may still claim SUPERADMIN — the DB is the source of truth.
    mockUserFindUnique.mockResolvedValue({ role: "USER" });
    expect(await isCurrentPlatformSuperadmin({ userId: "u1" })).toBe(false);
  });

  it("returns false when the user no longer exists", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    expect(await isCurrentPlatformSuperadmin({ userId: "u1" })).toBe(false);
  });

  it("returns false for the internal API key without a DB read", async () => {
    expect(await isCurrentPlatformSuperadmin({ userId: "internal" })).toBe(false);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("returns false for null auth", async () => {
    expect(await isCurrentPlatformSuperadmin(null)).toBe(false);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});
