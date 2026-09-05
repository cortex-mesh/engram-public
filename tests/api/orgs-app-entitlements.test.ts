import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockMembershipFindFirst,
  mockOrgFindUnique,
  mockEntitlementUpsert,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockMembershipFindFirst: vi.fn(),
  mockOrgFindUnique: vi.fn(),
  mockEntitlementUpsert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: {
      findFirst: mockMembershipFindFirst,
    },
    organization: {
      findUnique: mockOrgFindUnique,
    },
    orgAppEntitlement: {
      upsert: mockEntitlementUpsert,
    },
  },
}));

import { GET, PUT } from "@/app/api/orgs/[orgId]/app-entitlements/route";

function makeRequest(method: string, body?: Record<string, unknown>) {
  const request = new Request(
    "https://engram.rapidagent.dev:8443/api/orgs/org-1/app-entitlements",
    {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "Content-Type": "application/json" } : undefined,
    },
  );

  return new NextRequest(request);
}

describe("/api/orgs/[orgId]/app-entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("returns app entitlements for platform superadmins", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({
      id: "org-1",
      appEntitlements: [
        { appKey: "dashboard", enabled: true },
        { appKey: "thoughts", enabled: false },
      ],
    });

    const response = await GET(makeRequest("GET"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      appEntitlements: [
        { appKey: "dashboard", enabled: true },
        { appKey: "thoughts", enabled: false },
      ],
    });
  });

  it("forbids non-superadmins from listing app entitlements", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await GET(makeRequest("GET"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(403);
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins can manage organization app entitlements.",
    });
  });

  it("returns 404 when the org does not exist", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue(null);

    const response = await GET(makeRequest("GET"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Organization not found" });
  });

  it("rejects internal API key auth for app entitlement management", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });

    const response = await PUT(
      makeRequest("PUT", { appKey: "thoughts", enabled: true }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Internal API key auth is not allowed for organization management.",
    });
  });

  it("rejects cross-origin cookie-authenticated writes for app entitlements", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await PUT(
      new NextRequest(
        "https://engram.rapidagent.dev:8443/api/orgs/org-1/app-entitlements",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            origin: "https://dashboard.rapidagent.dev:8443",
            cookie: "engram-access=test-token",
            authorization: "Bearer ignored",
          },
          body: JSON.stringify({ appKey: "thoughts", enabled: true }),
        },
      ),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(403);
    expect(mockEntitlementUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin cookie-authenticated writes are not allowed.",
    });
  });

  it("allows same-origin cookie-authenticated app entitlement writes behind a trusted public origin", async () => {
    process.env.ENGRAM_ALLOWED_ORIGINS = "https://login.ctxhost.com";
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({ id: "org-1" });
    mockEntitlementUpsert.mockResolvedValue({
      appKey: "thoughts",
      enabled: true,
      org: {
        id: "org-1",
        name: "CORTEX",
        slug: "cortex",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-04T00:00:00.000Z"),
        members: [],
        invites: [],
        appEntitlements: [{ appKey: "thoughts", enabled: true }],
        featureEntitlements: [],
        _count: { members: 3, invites: 0 },
      },
    });

    const response = await PUT(
      new NextRequest("http://127.0.0.1:3104/api/orgs/org-1/app-entitlements", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          origin: "https://login.ctxhost.com",
          cookie: "engram-access=test-token",
        },
        body: JSON.stringify({ appKey: "thoughts", enabled: true }),
      }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockEntitlementUpsert).toHaveBeenCalled();
  });

  it("forbids non-superadmins from updating app entitlements", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "ADMIN" });

    const response = await PUT(
      makeRequest("PUT", { appKey: "thoughts", enabled: true }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(403);
    expect(mockEntitlementUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins can manage organization app entitlements.",
    });
  });

  it("validates app entitlement payloads", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await PUT(
      makeRequest("PUT", { appKey: "engram", enabled: "yes" as unknown as boolean }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockEntitlementUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "App entitlements must include a valid appKey and boolean enabled flag.",
    });
  });

  it("returns 404 when upserting an entitlement for a missing org", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue(null);

    const response = await PUT(
      makeRequest("PUT", { appKey: "thoughts", enabled: true }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(404);
    expect(mockEntitlementUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Organization not found" });
  });

  it("returns 404 when upsert hits a missing-org foreign-key race", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({ id: "org-1" });
    mockEntitlementUpsert.mockRejectedValue({ code: "P2003" });

    const response = await PUT(
      makeRequest("PUT", { appKey: "thoughts", enabled: true }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Organization not found" });
  });

  it("upserts app entitlements for platform superadmins who are not org members", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({ id: "org-1" });
    mockEntitlementUpsert.mockResolvedValue({
      appKey: "thoughts",
      enabled: true,
      org: {
        id: "org-1",
        name: "CORTEX",
        slug: "cortex",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-04T00:00:00.000Z"),
        members: [],
        invites: [],
        appEntitlements: [{ appKey: "thoughts", enabled: true }],
        featureEntitlements: [
          { appKey: "thoughts", featureKey: "projects", enabled: true },
        ],
        _count: { members: 3, invites: 0 },
      },
    });

    const response = await PUT(
      makeRequest("PUT", { appKey: "thoughts", enabled: true }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(mockEntitlementUpsert).toHaveBeenCalledWith({
      where: {
        orgId_appKey: {
          orgId: "org-1",
          appKey: "thoughts",
        },
      },
      create: {
        orgId: "org-1",
        appKey: "thoughts",
        enabled: true,
      },
      update: {
        enabled: true,
      },
      include: {
        org: {
          include: {
            members: {
              where: { userId: "user-1" },
              select: { role: true, createdAt: true },
            },
            appEntitlements: {
              orderBy: { appKey: "asc" },
              select: { appKey: true, enabled: true, accessMode: true, updatedAt: true },
            },
            featureEntitlements: {
              orderBy: [{ appKey: "asc" }, { featureKey: "asc" }],
              select: { appKey: true, featureKey: true, enabled: true, updatedAt: true },
            },
            invites: {
              select: { createdAt: true, updatedAt: true, acceptedAt: true, revokedAt: true },
            },
            _count: {
              select: { members: true, invites: true },
            },
          },
        },
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      organization: {
        id: "org-1",
        name: "CORTEX",
        slug: "cortex",
        role: "SUPERADMIN",
        isMember: false,
        appEntitlements: [{ appKey: "thoughts", enabled: true }],
        featureEntitlements: [
          { appKey: "thoughts", featureKey: "projects", enabled: true },
        ],
        userAppOverrides: [],
        appAccess: [{ appKey: "thoughts", canAccess: true }],
        memberCount: 3,
        pendingInviteCount: 0,
        latestActivityAt: "2026-04-04T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    });
  });

  it("preserves org membership when a platform superadmin is also an org member", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({ id: "org-1" });
    mockEntitlementUpsert.mockResolvedValue({
      appKey: "thoughts",
      enabled: true,
      org: {
        id: "org-1",
        name: "CORTEX",
        slug: "cortex",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-04T00:00:00.000Z"),
        members: [{ role: "OWNER", createdAt: new Date("2026-04-04T00:00:00.000Z") }],
        appEntitlements: [{ appKey: "thoughts", enabled: true }],
        featureEntitlements: [],
        invites: [],
        _count: { members: 3, invites: 0 },
      },
    });

    const response = await PUT(
      makeRequest("PUT", { appKey: "thoughts", enabled: true }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      organization: {
        id: "org-1",
        name: "CORTEX",
        slug: "cortex",
        role: "SUPERADMIN",
        isMember: true,
        appEntitlements: [{ appKey: "thoughts", enabled: true }],
        featureEntitlements: [],
        userAppOverrides: [],
        appAccess: [{ appKey: "thoughts", canAccess: true }],
        memberCount: 3,
        pendingInviteCount: 0,
        latestActivityAt: "2026-04-04T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    });
  });
});
