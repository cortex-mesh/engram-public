import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockVerifyToken, mockFindUnique } = vi.hoisted(() => ({
  mockVerifyToken: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock("@/lib/jwt", () => ({
  verifyToken: mockVerifyToken,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mockFindUnique,
    },
  },
}));

import { getCurrentUserFromAccessToken } from "@/lib/viewer";

describe("getCurrentUserFromAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the access token is missing or invalid", async () => {
    expect(await getCurrentUserFromAccessToken(undefined)).toBeNull();

    mockVerifyToken.mockRejectedValue(new Error("bad token"));
    expect(await getCurrentUserFromAccessToken("bad-token")).toBeNull();
  });

  it("returns the current user for a valid access token", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "user-1", type: "access" });
    mockFindUnique.mockResolvedValue({
      id: "user-1",
      email: "admin@ctxhost.com",
      username: "ctxhost-admin",
      displayName: "CTXHost Admin",
      role: "SUPERADMIN",
      emailVerified: true,
      avatarUrl: null,
      oauthAccounts: [{ provider: "github" }],
      passwordHash: "$2b$12$hash",
    });

    await expect(getCurrentUserFromAccessToken("good-token")).resolves.toEqual({
      id: "user-1",
      email: "admin@ctxhost.com",
      username: "ctxhost-admin",
      displayName: "CTXHost Admin",
      role: "SUPERADMIN",
      emailVerified: true,
      avatarUrl: null,
      oauthProviders: ["github"],
      hasPassword: true,
    });
  });
});
