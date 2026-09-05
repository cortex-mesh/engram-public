import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticateRequest, mockOrgMemberFindFirst, mockOrgAppFindUnique, mockOrgAppUpdate } =
  vi.hoisted(() => ({
    mockAuthenticateRequest: vi.fn(),
    mockOrgMemberFindFirst: vi.fn(),
    mockOrgAppFindUnique: vi.fn(),
    mockOrgAppUpdate: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: { findFirst: mockOrgMemberFindFirst },
    orgAppEntitlement: {
      findUnique: mockOrgAppFindUnique,
      update: mockOrgAppUpdate,
    },
  },
}));

import { PATCH } from "@/app/api/orgs/[orgId]/app-entitlements/[appKey]/route";

const FIXED_DATE = new Date("2026-07-23T12:00:00.000Z");

function makeRequest(body?: Record<string, unknown>, headers?: Record<string, string>) {
  return new NextRequest(
    new Request("https://engram.rapidagent.dev:8443/api/orgs/org-1/app-entitlements/gyrus", {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
      headers: { "Content-Type": "application/json", ...headers },
    }),
  );
}

function makeContext(appKey = "gyrus") {
  return { params: Promise.resolve({ orgId: "org-1", appKey }) };
}

describe("PATCH /api/orgs/[orgId]/app-entitlements/[appKey]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("sets the access mode for a platform superadmin", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "admin-1", role: "SUPERADMIN" });
    mockOrgAppUpdate.mockResolvedValue({
      appKey: "gyrus",
      enabled: true,
      accessMode: "RESTRICTED",
      updatedAt: FIXED_DATE,
    });

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext());

    expect(response.status).toBe(200);
    expect(mockOrgAppFindUnique).not.toHaveBeenCalled();
    expect(mockOrgAppUpdate).toHaveBeenCalledWith({
      where: { orgId_appKey: { orgId: "org-1", appKey: "gyrus" } },
      data: { accessMode: "RESTRICTED" },
      select: { appKey: true, enabled: true, accessMode: true, updatedAt: true },
    });
    await expect(response.json()).resolves.toEqual({
      appEntitlement: {
        appKey: "gyrus",
        enabled: true,
        accessMode: "RESTRICTED",
        updatedAt: "2026-07-23T12:00:00.000Z",
      },
    });
  });

  it("allows an org OWNER to set the access mode for an app the org has enabled", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "owner-1", role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
    mockOrgAppFindUnique.mockResolvedValue({ enabled: true });
    mockOrgAppUpdate.mockResolvedValue({
      appKey: "gyrus",
      enabled: true,
      accessMode: "RESTRICTED",
      updatedAt: FIXED_DATE,
    });

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext());

    expect(response.status).toBe(200);
    expect(mockOrgAppFindUnique).toHaveBeenCalledWith({
      where: { orgId_appKey: { orgId: "org-1", appKey: "gyrus" } },
      select: { enabled: true },
    });
  });

  it("allows an org ADMIN to set the access mode back to ALL_MEMBERS", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "admin-2", role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "ADMIN" });
    mockOrgAppFindUnique.mockResolvedValue({ enabled: true });
    mockOrgAppUpdate.mockResolvedValue({
      appKey: "gyrus",
      enabled: true,
      accessMode: "ALL_MEMBERS",
      updatedAt: FIXED_DATE,
    });

    const response = await PATCH(makeRequest({ accessMode: "ALL_MEMBERS" }), makeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      appEntitlement: {
        appKey: "gyrus",
        enabled: true,
        accessMode: "ALL_MEMBERS",
        updatedAt: "2026-07-23T12:00:00.000Z",
      },
    });
  });

  it("forbids a plain MEMBER from setting the access mode", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "member-1", role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "MEMBER" });

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext());

    expect(response.status).toBe(403);
    expect(mockOrgAppUpdate).not.toHaveBeenCalled();
  });

  it("forbids a non-member of the org", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "stranger-1", role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue(null);

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext());

    expect(response.status).toBe(403);
    expect(mockOrgAppUpdate).not.toHaveBeenCalled();
  });

  it("blocks an OWNER from setting the access mode on an app the org has not enabled", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "owner-1", role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
    mockOrgAppFindUnique.mockResolvedValue(null);

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext());

    expect(response.status).toBe(400);
    expect(mockOrgAppUpdate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error:
        "Organization owners and admins can only set the access mode for apps the org has enabled.",
    });
  });

  it("returns 404 when the org has no entitlement row for the app yet (even for superadmin)", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "admin-1", role: "SUPERADMIN" });
    mockOrgAppUpdate.mockRejectedValue({ code: "P2025" });

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Organization does not have this app entitled.",
    });
  });

  it("rejects an unknown app key", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "admin-1", role: "SUPERADMIN" });

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext("not-a-real-app"));

    expect(response.status).toBe(400);
    expect(mockOrgAppUpdate).not.toHaveBeenCalled();
  });

  it("rejects an invalid access mode value", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "admin-1", role: "SUPERADMIN" });

    const response = await PATCH(makeRequest({ accessMode: "EVERYONE" }), makeContext());

    expect(response.status).toBe(400);
    expect(mockOrgAppUpdate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "App access mode must be one of: ALL_MEMBERS, RESTRICTED.",
    });
  });

  it("rejects internal API key auth", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext());

    expect(response.status).toBe(403);
    expect(mockOrgAppUpdate).not.toHaveBeenCalled();
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);

    const response = await PATCH(makeRequest({ accessMode: "RESTRICTED" }), makeContext());

    expect(response.status).toBe(401);
  });

  it("rejects cross-origin cookie-authenticated writes", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "admin-1", role: "SUPERADMIN" });

    const response = await PATCH(
      makeRequest(
        { accessMode: "RESTRICTED" },
        { origin: "https://attacker.example.com", cookie: "engram-access=stolen" },
      ),
      makeContext(),
    );

    expect(response.status).toBe(403);
    expect(mockOrgAppUpdate).not.toHaveBeenCalled();
  });
});
