import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockOAuthFindUnique,
  mockOAuthCreate,
  mockUserFindUnique,
  mockUserUpdate,
} = vi.hoisted(() => ({
  mockOAuthFindUnique: vi.fn(),
  mockOAuthCreate: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    oAuthAccount: { findUnique: mockOAuthFindUnique, create: mockOAuthCreate },
    user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
  },
}));

import { findOrCreateOAuthUser } from "@/lib/db/oauth-accounts";

const BASE = {
  provider: "github",
  providerAccountId: "123",
  email: "victim@example.com",
  displayName: "V",
};

describe("findOrCreateOAuthUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOAuthFindUnique.mockResolvedValue(null); // no existing link
  });

  it("does NOT link to an existing user when the provider email is UNVERIFIED", async () => {
    mockUserFindUnique.mockResolvedValue({ id: "victim-1", emailVerified: true });

    const result = await findOrCreateOAuthUser({ ...BASE, emailVerified: false });

    // Refused — falls through to the waitlist (null), no link created.
    expect(result).toBeNull();
    expect(mockOAuthCreate).not.toHaveBeenCalled();
    // It must not even query for the user on the unverified path.
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("links to an existing user when the provider email IS verified", async () => {
    mockUserFindUnique.mockResolvedValue({
      id: "victim-1",
      emailVerified: false,
      avatarUrl: null,
    });

    const result = await findOrCreateOAuthUser({
      ...BASE,
      emailVerified: true,
      avatarUrl: "https://avatar",
    });

    expect(result).toEqual({ user: expect.objectContaining({ id: "victim-1" }), isNewUser: false });
    expect(mockOAuthCreate).toHaveBeenCalledWith({
      data: { userId: "victim-1", provider: "github", providerAccountId: "123" },
    });
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "victim-1" },
      data: { avatarUrl: "https://avatar", emailVerified: true },
    });
  });

  it("returns an already-linked account regardless of verification", async () => {
    mockOAuthFindUnique.mockResolvedValue({ user: { id: "linked-1" } });

    const result = await findOrCreateOAuthUser({ ...BASE, emailVerified: false });

    expect(result).toEqual({ user: { id: "linked-1" }, isNewUser: false });
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});
