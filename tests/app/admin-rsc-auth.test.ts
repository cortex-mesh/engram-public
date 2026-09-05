import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCookies,
  mockHeaders,
  mockNotFound,
  mockRedirect,
  mockUserFindUnique,
  mockListAdminUsers,
  mockListAdminClients,
  mockListAdminWaitlistRequests,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockHeaders: vi.fn(),
  mockNotFound: vi.fn(),
  mockRedirect: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockListAdminUsers: vi.fn(),
  mockListAdminClients: vi.fn(),
  mockListAdminWaitlistRequests: vi.fn(),
}));

process.env.ENGRAM_JWT_SECRET = "test-secret-for-admin-rsc-auth-tests";

vi.mock("next/headers", () => ({
  cookies: mockCookies,
  headers: mockHeaders,
}));

vi.mock("next/navigation", () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockUserFindUnique } },
}));

vi.mock("@/lib/admin-console", () => ({
  listAdminUsers: mockListAdminUsers,
  listAdminClients: mockListAdminClients,
  listAdminWaitlistRequests: mockListAdminWaitlistRequests,
}));

import AdminUsersPage from "@/app/admin/users/page";
import AdminWaitlistPage from "@/app/admin/waitlist/page";
import { generateTokenPair } from "@/lib/jwt";

function emptyCookieStore() {
  return { get: vi.fn() };
}

function headerStore(values: Record<string, string>) {
  return {
    get: vi.fn((name: string) => values[name.toLowerCase()] ?? null),
  };
}

describe("admin RSC authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,platform.ctxhost.com";
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.NEXT_PUBLIC_PLATFORM_ADMIN_URL = "https://platform.ctxhost.com/admin";
    mockNotFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mockRedirect.mockImplementation((target: string) => {
      throw new Error(`NEXT_REDIRECT:${target}`);
    });
    mockCookies.mockResolvedValue(emptyCookieStore());
    mockHeaders.mockResolvedValue(headerStore({
      host: "platform.ctxhost.com",
      "x-engram-request-path": "/admin/users",
    }));
  });

  it("redirects anonymous platform admin requests through the auth handoff", async () => {
    await expect(AdminUsersPage()).rejects.toThrow(
      "NEXT_REDIRECT:/api/auth/continue?redirect_uri=%2Fadmin%2Fusers",
    );

    expect(mockListAdminUsers).not.toHaveBeenCalled();
    expect(mockListAdminClients).not.toHaveBeenCalled();
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("redirects anonymous waitlist admin requests back to the requested URL", async () => {
    mockHeaders.mockResolvedValue(headerStore({
      host: "platform.ctxhost.com",
      "x-engram-request-path": "/admin/waitlist?tab=pending",
    }));

    await expect(AdminWaitlistPage()).rejects.toThrow(
      "NEXT_REDIRECT:/api/auth/continue?redirect_uri=%2Fadmin%2Fwaitlist%3Ftab%3Dpending",
    );

    expect(mockListAdminWaitlistRequests).not.toHaveBeenCalled();
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for authenticated non-superadmins without fetching admin data", async () => {
    const { accessToken } = await generateTokenPair({
      id: "user-1",
      role: "USER",
    });
    mockHeaders.mockResolvedValue(headerStore({
      host: "platform.ctxhost.com",
      "x-engram-request-path": "/admin/users",
      "x-engram-access": accessToken,
    }));
    mockUserFindUnique.mockResolvedValue({ role: "USER" });

    await expect(AdminUsersPage()).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { role: true },
    });
    expect(mockListAdminUsers).not.toHaveBeenCalled();
    expect(mockListAdminClients).not.toHaveBeenCalled();
  });

  it("accepts the middleware-forwarded access header and re-reads SUPERADMIN from the DB", async () => {
    const { accessToken } = await generateTokenPair({
      id: "admin-1",
      role: "SUPERADMIN",
    });
    mockHeaders.mockResolvedValue(headerStore({ "x-engram-access": accessToken }));
    mockUserFindUnique.mockResolvedValue({ role: "SUPERADMIN" });
    mockListAdminUsers.mockResolvedValue([]);
    mockListAdminClients.mockResolvedValue([]);
    mockListAdminWaitlistRequests.mockResolvedValue([]);

    await expect(AdminUsersPage()).resolves.toBeTruthy();

    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      select: { role: true },
    });
    expect(mockListAdminUsers).toHaveBeenCalled();
    expect(mockListAdminClients).toHaveBeenCalled();
  });

  it("redirects login-host admin requests to the canonical platform host", async () => {
    mockHeaders.mockResolvedValue(headerStore({
      host: "login.ctxhost.com",
      "x-engram-request-path": "/admin/users?filter=active",
    }));

    await expect(AdminUsersPage()).rejects.toThrow(
      "NEXT_REDIRECT:https://platform.ctxhost.com/admin/users?filter=active",
    );

    expect(mockListAdminUsers).not.toHaveBeenCalled();
    expect(mockListAdminClients).not.toHaveBeenCalled();
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("derives the canonical platform host from ENGRAM_URL when the platform URL env is absent", async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = "login.dev.ctxhost.com,platform.dev.ctxhost.com";
    process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";
    delete process.env.NEXT_PUBLIC_PLATFORM_ADMIN_URL;
    mockHeaders.mockResolvedValue(headerStore({
      host: "login.dev.ctxhost.com",
      "x-engram-request-path": "/admin/waitlist?tab=pending",
    }));

    await expect(AdminWaitlistPage()).rejects.toThrow(
      "NEXT_REDIRECT:https://platform.dev.ctxhost.com/admin/waitlist?tab=pending",
    );

    expect(mockListAdminWaitlistRequests).not.toHaveBeenCalled();
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("does not canonicalize to a platform host outside ENGRAM_ALLOWED_HOSTS", async () => {
    process.env.NEXT_PUBLIC_PLATFORM_ADMIN_URL = "https://platform.dev.ctxhost.com/admin";
    mockHeaders.mockResolvedValue(headerStore({
      host: "login.ctxhost.com",
      "x-engram-request-path": "/admin/users",
    }));

    await expect(AdminUsersPage()).rejects.toThrow(
      "NEXT_REDIRECT:/api/auth/continue?redirect_uri=%2Fadmin%2Fusers",
    );

    expect(mockRedirect).not.toHaveBeenCalledWith(
      expect.stringContaining("platform.dev.ctxhost.com"),
    );
    expect(mockListAdminUsers).not.toHaveBeenCalled();
    expect(mockListAdminClients).not.toHaveBeenCalled();
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});
