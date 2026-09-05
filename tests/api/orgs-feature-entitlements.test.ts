import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockOrgFindUnique,
  mockFeatureFindMany,
  mockFeatureUpsert,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockOrgFindUnique: vi.fn(),
  mockFeatureFindMany: vi.fn(),
  mockFeatureUpsert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      findUnique: mockOrgFindUnique,
    },
    orgAppFeatureEntitlement: {
      findMany: mockFeatureFindMany,
      upsert: mockFeatureUpsert,
    },
  },
}));

import { GET, PUT } from "@/app/api/orgs/[orgId]/feature-entitlements/route";

function makeRequest(method: string, body?: Record<string, unknown>) {
  const request = new Request(
    "https://engram.rapidagent.dev:8443/api/orgs/org-1/feature-entitlements",
    {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "Content-Type": "application/json" } : undefined,
    },
  );

  return new NextRequest(request);
}

describe("/api/orgs/[orgId]/feature-entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("lists feature entitlements for platform superadmins", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({ id: "org-1" });
    mockFeatureFindMany.mockResolvedValue([
      { appKey: "thoughts", featureKey: "adr", enabled: false },
      { appKey: "thoughts", featureKey: "projects", enabled: true },
    ]);

    const response = await GET(makeRequest("GET"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(mockFeatureFindMany).toHaveBeenCalledWith({
      where: { orgId: "org-1" },
      orderBy: [{ appKey: "asc" }, { featureKey: "asc" }],
      select: { appKey: true, featureKey: true, enabled: true },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      featureEntitlements: [
        { appKey: "thoughts", featureKey: "adr", enabled: false },
        { appKey: "thoughts", featureKey: "projects", enabled: true },
      ],
    });
  });

  it("forbids non-superadmins from listing feature entitlements", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await GET(makeRequest("GET"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(403);
    expect(mockFeatureFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins can manage organization feature entitlements.",
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

  it("rejects internal API key auth for feature entitlement listing", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });

    const response = await GET(makeRequest("GET"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(403);
    expect(mockFeatureFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Internal API key auth is not allowed for organization management.",
    });
  });

  it("rejects internal API key auth for feature entitlement management", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });

    const response = await PUT(
      makeRequest("PUT", {
        appKey: "thoughts",
        featureKey: "projects",
        enabled: true,
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Internal API key auth is not allowed for organization management.",
    });
  });

  it("rejects cross-origin cookie-authenticated writes for feature entitlements", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await PUT(
      new NextRequest(
        "https://engram.rapidagent.dev:8443/api/orgs/org-1/feature-entitlements",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            origin: "https://dashboard.rapidagent.dev:8443",
            cookie: "engram-access=test-token",
            authorization: "Bearer ignored",
          },
          body: JSON.stringify({
            appKey: "thoughts",
            featureKey: "projects",
            enabled: true,
          }),
        },
      ),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(403);
    expect(mockFeatureUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin cookie-authenticated writes are not allowed.",
    });
  });

  it("allows same-origin cookie-authenticated feature writes behind a trusted public origin", async () => {
    process.env.ENGRAM_ALLOWED_ORIGINS = "https://login.ctxhost.com";
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({
      id: "org-1",
      appEntitlements: [{ appKey: "thoughts", enabled: true }],
    });
    mockFeatureUpsert.mockResolvedValue({
      orgId: "org-1",
      appKey: "thoughts",
      featureKey: "projects",
      enabled: true,
    });
    mockFeatureFindMany.mockResolvedValue([
      { appKey: "thoughts", featureKey: "projects", enabled: true },
    ]);

    const response = await PUT(
      new NextRequest("http://127.0.0.1:3104/api/orgs/org-1/feature-entitlements", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          origin: "https://login.ctxhost.com",
          cookie: "engram-access=test-token",
        },
        body: JSON.stringify({
          appKey: "thoughts",
          featureKey: "projects",
          enabled: true,
        }),
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockFeatureUpsert).toHaveBeenCalled();
  });

  it("forbids non-superadmins from updating feature entitlements", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "ADMIN" });

    const response = await PUT(
      makeRequest("PUT", {
        appKey: "thoughts",
        featureKey: "projects",
        enabled: true,
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(403);
    expect(mockFeatureUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins can manage organization feature entitlements.",
    });
  });

  it("validates app and feature keys before updating", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await PUT(
      makeRequest("PUT", {
        appKey: "thoughts",
        featureKey: "billing",
        enabled: true,
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockFeatureUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Feature entitlements must include a valid appKey, featureKey, and boolean enabled flag.",
    });
  });

  it("requires the app to be enabled before granting a feature entitlement", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({
      id: "org-1",
      appEntitlements: [{ appKey: "thoughts", enabled: false }],
    });

    const response = await PUT(
      makeRequest("PUT", {
        appKey: "thoughts",
        featureKey: "projects",
        enabled: true,
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockFeatureUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error:
        "An organization must have an app enabled before feature entitlements can be managed.",
    });
  });

  it("requires the app to be entitled before granting a feature entitlement", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({
      id: "org-1",
      appEntitlements: [],
    });

    const response = await PUT(
      makeRequest("PUT", {
        appKey: "thoughts",
        featureKey: "projects",
        enabled: true,
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockFeatureUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "An organization must be entitled to an app before feature entitlements can be managed.",
    });
  });

  it("returns 404 when updating a missing org", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue(null);

    const response = await PUT(
      makeRequest("PUT", {
        appKey: "thoughts",
        featureKey: "projects",
        enabled: true,
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(404);
    expect(mockFeatureUpsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Organization not found" });
  });

  it("returns 404 when feature upsert hits a missing-app-entitlement race", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({
      id: "org-1",
      appEntitlements: [{ appKey: "thoughts", enabled: true }],
    });
    mockFeatureUpsert.mockRejectedValue({ code: "P2003" });

    const response = await PUT(
      makeRequest("PUT", {
        appKey: "thoughts",
        featureKey: "projects",
        enabled: true,
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Organization not found" });
  });

  it("upserts feature entitlements for entitled apps", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrgFindUnique.mockResolvedValue({
      id: "org-1",
      appEntitlements: [{ appKey: "thoughts", enabled: true }],
    });
    mockFeatureUpsert.mockResolvedValue({
      appKey: "thoughts",
      featureKey: "projects",
      enabled: true,
    });
    mockFeatureFindMany.mockResolvedValue([
      { appKey: "thoughts", featureKey: "adr", enabled: false },
      { appKey: "thoughts", featureKey: "projects", enabled: true },
    ]);

    const response = await PUT(
      makeRequest("PUT", {
        appKey: "thoughts",
        featureKey: "projects",
        enabled: true,
      }),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(mockFeatureUpsert).toHaveBeenCalledWith({
      where: {
        orgId_appKey_featureKey: {
          orgId: "org-1",
          appKey: "thoughts",
          featureKey: "projects",
        },
      },
      create: {
        orgId: "org-1",
        appKey: "thoughts",
        featureKey: "projects",
        enabled: true,
      },
      update: {
        enabled: true,
      },
    });
    expect(mockFeatureFindMany).toHaveBeenCalledWith({
      where: { orgId: "org-1" },
      orderBy: [{ appKey: "asc" }, { featureKey: "asc" }],
      select: { appKey: true, featureKey: true, enabled: true },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      featureEntitlements: [
        { appKey: "thoughts", featureKey: "adr", enabled: false },
        { appKey: "thoughts", featureKey: "projects", enabled: true },
      ],
    });
  });
});
