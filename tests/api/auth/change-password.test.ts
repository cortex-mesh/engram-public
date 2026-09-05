import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockUserFindUnique,
  mockUserUpdate,
  mockRefreshTokenDeleteMany,
  mockVerifyPassword,
  mockHashPassword,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockRefreshTokenDeleteMany: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockHashPassword: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
    refreshToken: { deleteMany: mockRefreshTokenDeleteMany },
  },
}));

vi.mock("@/lib/password", () => ({
  verifyPassword: mockVerifyPassword,
  hashPassword: mockHashPassword,
}));

import { POST } from "@/app/api/auth/change-password/route";

const LOGIN_ORIGIN = "https://login.dev.ctxhost.com";

function makeRequest(opts: {
  body?: Record<string, unknown>;
  origin?: string;
  cookie?: string;
  bearer?: boolean;
  secFetchSite?: string;
}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = "Bearer some-token";
  if (opts.secFetchSite) headers["sec-fetch-site"] = opts.secFetchSite;
  return new NextRequest(`${LOGIN_ORIGIN}/api/auth/change-password`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

describe("POST /api/auth/change-password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_URL = LOGIN_ORIGIN;
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockUserFindUnique.mockResolvedValue({
      id: "user-1",
      passwordHash: "$2b$12$existinghashexistinghashexistinghashexistinghash00",
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockHashPassword.mockResolvedValue("$2b$12$newhash");
    mockUserUpdate.mockResolvedValue({});
    mockRefreshTokenDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ body: { currentPassword: "old", newPassword: "newpass12" } }),
    );
    expect(res.status).toBe(401);
  });

  it("changes the password for a same-origin cookie request", async () => {
    const res = await POST(
      makeRequest({
        origin: LOGIN_ORIGIN,
        cookie: "engram-access=valid",
        body: { currentPassword: "oldpass12", newPassword: "newpass12" },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalled();
    expect(mockRefreshTokenDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("blocks a cross-site cookie write (CSRF) with 403", async () => {
    const res = await POST(
      makeRequest({
        origin: "https://attacker.example.com",
        cookie: "engram-access=stolen",
        body: { currentPassword: "oldpass12", newPassword: "newpass12" },
      }),
    );
    expect(res.status).toBe(403);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("blocks a cookie write with NO Origin and no Sec-Fetch-Site (fail closed)", async () => {
    const res = await POST(
      makeRequest({
        cookie: "engram-access=stolen",
        body: { currentPassword: "oldpass12", newPassword: "newpass12" },
      }),
    );
    expect(res.status).toBe(403);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("allows a cookie write when Sec-Fetch-Site is same-origin", async () => {
    const res = await POST(
      makeRequest({
        cookie: "engram-access=valid",
        secFetchSite: "same-origin",
        body: { currentPassword: "oldpass12", newPassword: "newpass12" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows a Bearer (no cookie) client without an Origin", async () => {
    const res = await POST(
      makeRequest({
        bearer: true,
        body: { currentPassword: "oldpass12", newPassword: "newpass12" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a wrong current password with 401", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const res = await POST(
      makeRequest({
        bearer: true,
        body: { currentPassword: "wrong", newPassword: "newpass12" },
      }),
    );
    expect(res.status).toBe(401);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("requires the current password when one is set", async () => {
    const res = await POST(
      makeRequest({ bearer: true, body: { newPassword: "newpass12" } }),
    );
    expect(res.status).toBe(400);
  });

  it("blocks an OAuth-only account from setting an initial password (409)", async () => {
    mockUserFindUnique.mockResolvedValue({ id: "user-1", passwordHash: null });
    const res = await POST(
      makeRequest({ bearer: true, body: { newPassword: "newpass12" } }),
    );
    expect(res.status).toBe(409);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("rejects internal API key auth", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });
    const res = await POST(
      makeRequest({ bearer: true, body: { newPassword: "newpass12" } }),
    );
    expect(res.status).toBe(403);
  });

  it.each([
    ["too short", "short1"],
    ["whitespace only", "         "],
  ])("rejects an invalid new password (%s)", async (_label, newPassword) => {
    const res = await POST(
      makeRequest({ bearer: true, body: { currentPassword: "oldpass12", newPassword } }),
    );
    expect(res.status).toBe(400);
  });
});
