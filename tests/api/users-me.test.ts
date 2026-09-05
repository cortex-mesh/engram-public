import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticateRequest, mockUserUpdate } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockUserUpdate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ authenticateRequest: mockAuthenticateRequest }));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { update: mockUserUpdate } },
}));

import { PATCH } from "@/app/api/users/me/route";

const ORIGIN = "https://login.dev.ctxhost.com";

function makeRequest(opts: {
  origin?: string;
  cookie?: string;
  bearer?: boolean;
  body?: Record<string, unknown>;
}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = "Bearer token";
  return new NextRequest(`${ORIGIN}/api/users/me`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(opts.body ?? { displayName: "New Name" }),
  });
}

describe("PATCH /api/users/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_URL = ORIGIN;
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockUserUpdate.mockResolvedValue({
      id: "user-1",
      username: "u",
      displayName: "New Name",
      email: "u@example.com",
      emailVerified: true,
      avatarUrl: null,
      role: "USER",
      createdAt: new Date(),
      passwordHash: null,
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);
    const res = await PATCH(makeRequest({ bearer: true }));
    expect(res.status).toBe(401);
  });

  it("blocks a cross-site cookie write (CSRF) with 403", async () => {
    const res = await PATCH(
      makeRequest({ origin: "https://attacker.example.com", cookie: "engram-access=stolen" }),
    );
    expect(res.status).toBe(403);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("blocks a cookie write with no Origin and no Sec-Fetch-Site (fail closed)", async () => {
    const res = await PATCH(makeRequest({ cookie: "engram-access=stolen" }));
    expect(res.status).toBe(403);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("allows a same-origin cookie write", async () => {
    const res = await PATCH(makeRequest({ origin: ORIGIN, cookie: "engram-access=valid" }));
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalled();
  });

  it("allows a Bearer (no cookie) client", async () => {
    const res = await PATCH(makeRequest({ bearer: true }));
    expect(res.status).toBe(200);
  });
});
