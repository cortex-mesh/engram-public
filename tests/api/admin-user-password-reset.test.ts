import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockUserFindUnique,
  mockUserUpdate,
  mockRefreshTokenDeleteMany,
  mockTransaction,
  mockHashPassword,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockRefreshTokenDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockHashPassword: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mockUserFindUnique,
      update: mockUserUpdate,
    },
    refreshToken: {
      deleteMany: mockRefreshTokenDeleteMany,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/password", () => ({
  hashPassword: mockHashPassword,
}));

import { POST } from "@/app/api/admin/users/[userId]/password/route";

function makeRequest() {
  return new NextRequest("https://platform.dev.ctxhost.com/api/admin/users/user-2/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/admin/users/[userId]/password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
    mockTransaction.mockImplementation(async (operations: unknown[]) => operations);
  });

  it("forbids non-superadmins from resetting user passwords", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ userId: "user-2" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins can manage users.",
    });
  });

  it("returns 404 when the target user does not exist", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockUserFindUnique.mockResolvedValue(null);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ userId: "user-missing" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "User not found.",
    });
  });

  it("rejects resetting platform superadmin passwords from admin", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockUserFindUnique.mockResolvedValue({
      id: "user-2",
      email: "admin@ctxhost.com",
      username: "ctxhost-admin",
      displayName: "CTXHost Admin",
      role: "SUPERADMIN",
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ userId: "user-2" }),
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Platform superadmin passwords cannot be reset from this admin flow.",
    });
  });

  it("resets the target user's password and invalidates their refresh tokens atomically", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockUserFindUnique.mockResolvedValue({
      id: "user-2",
      email: "roland@example.com",
      username: "roland",
      displayName: "Roland Parnaso",
      role: "USER",
    });
    mockHashPassword.mockResolvedValue("hashed-password");

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ userId: "user-2" }),
    });

    expect(mockHashPassword).toHaveBeenCalledWith(expect.any(String));
    expect(mockTransaction).toHaveBeenCalledWith([
      mockUserUpdate.mock.results[0]?.value,
      mockRefreshTokenDeleteMany.mock.results[0]?.value,
    ]);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "user-2" },
      data: { passwordHash: "hashed-password" },
    });
    expect(mockRefreshTokenDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-2" },
    });
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.user).toEqual({
      id: "user-2",
      email: "roland@example.com",
      username: "roland",
      displayName: "Roland Parnaso",
      role: "USER",
    });
    expect(payload.temporaryPassword).toEqual(expect.any(String));
    expect(payload.temporaryPassword.length).toBeGreaterThanOrEqual(16);
  });
});
