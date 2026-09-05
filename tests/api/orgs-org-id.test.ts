import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticateRequest, mockFindFirst, mockUpdate } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: {
      findFirst: mockFindFirst,
    },
    organization: {
      update: mockUpdate,
    },
  },
}));

import { PATCH } from "@/app/api/orgs/[orgId]/route";

function makeRequest(body: Record<string, unknown>) {
  const request = new Request("https://engram.rapidagent.dev:8443/api/orgs/org-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

  return new NextRequest(request);
}

describe("PATCH /api/orgs/[orgId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("forbids members from updating organization settings", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockFindFirst.mockResolvedValue({ role: "MEMBER" });

    const response = await PATCH(makeRequest({ name: "Updated Org" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only organization admins and owners can update organization settings.",
    });
  });

  it("rejects cross-origin cookie-authenticated writes even when an authorization header is present", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await PATCH(
      new NextRequest("https://engram.rapidagent.dev:8443/api/orgs/org-1", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          origin: "https://dashboard.rapidagent.dev:8443",
          cookie: "engram-access=test-token",
          authorization: "Bearer not-the-auth-mechanism",
        },
        body: JSON.stringify({ name: "Updated Org" }),
      }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin cookie-authenticated writes are not allowed.",
    });
  });

  it("allows same-origin cookie-authenticated writes behind a trusted public origin", async () => {
    process.env.ENGRAM_ALLOWED_ORIGINS = "https://login.ctxhost.com";
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockFindFirst.mockResolvedValue({ role: "OWNER" });
    mockUpdate.mockResolvedValue({
      id: "org-1",
      name: "Updated Org",
      slug: "updated-org",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: [{ role: "OWNER", createdAt: new Date("2026-04-04T00:00:00.000Z") }],
      appEntitlements: [],
      featureEntitlements: [],
      _count: { members: 3, invites: 0 },
    });

    const response = await PATCH(
      new NextRequest("http://127.0.0.1:3104/api/orgs/org-1", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          origin: "https://login.ctxhost.com",
          cookie: "engram-access=test-token",
        },
        body: JSON.stringify({ name: "Updated Org" }),
      }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("rejects internal API key auth for organization updates", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });

    const response = await PATCH(makeRequest({ name: "Updated Org" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Internal API key auth is not allowed for organization management.",
    });
  });

  it("allows platform superadmins to update organization settings without an explicit org membership", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockFindFirst.mockResolvedValue(null);
    mockUpdate.mockResolvedValue({
      id: "org-1",
      name: "Updated Org",
      slug: "updated-org",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: [],
      appEntitlements: [{ appKey: "thoughts", enabled: true }],
      featureEntitlements: [
        { appKey: "thoughts", featureKey: "adr", enabled: false },
        { appKey: "thoughts", featureKey: "projects", enabled: true },
      ],
      _count: { members: 3, invites: 0 },
    });

    const response = await PATCH(
      makeRequest({ name: "Updated Org", slug: "updated-org" }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: {
        name: "Updated Org",
        slug: "updated-org",
      },
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
        userAppOverrides: {
          where: { userId: "user-1" },
          orderBy: { appKey: "asc" },
          select: { appKey: true, enabled: true },
        },
        invites: {
          select: { createdAt: true, updatedAt: true, acceptedAt: true, revokedAt: true },
        },
        _count: {
          select: { members: true, invites: true },
        },
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      organization: {
        id: "org-1",
        name: "Updated Org",
        slug: "updated-org",
        role: "OWNER",
        isMember: false,
        appEntitlements: [{ appKey: "thoughts", enabled: true }],
        featureEntitlements: [
          { appKey: "thoughts", featureKey: "adr", enabled: false },
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

  it("returns 404 when a platform superadmin targets a missing org", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockFindFirst.mockResolvedValue(null);
    mockUpdate.mockRejectedValue({ code: "P2025" });

    const response = await PATCH(makeRequest({ name: "Updated Org" }), {
      params: Promise.resolve({ orgId: "org-missing" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Organization not found",
    });
  });

  it("updates organization settings for owners", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockFindFirst.mockResolvedValue({ role: "OWNER" });
    mockUpdate.mockResolvedValue({
      id: "org-1",
      name: "Updated Org",
      slug: "updated-org",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: [{ role: "OWNER", createdAt: new Date("2026-04-04T00:00:00.000Z") }],
      appEntitlements: [{ appKey: "thoughts", enabled: true }],
      featureEntitlements: [
        { appKey: "thoughts", featureKey: "adr", enabled: false },
        { appKey: "thoughts", featureKey: "projects", enabled: true },
      ],
      _count: { members: 3, invites: 0 },
    });

    const response = await PATCH(
      makeRequest({ name: "Updated Org", slug: "updated-org" }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: {
        name: "Updated Org",
        slug: "updated-org",
      },
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
        userAppOverrides: {
          where: { userId: "user-1" },
          orderBy: { appKey: "asc" },
          select: { appKey: true, enabled: true },
        },
        invites: {
          select: { createdAt: true, updatedAt: true, acceptedAt: true, revokedAt: true },
        },
        _count: {
          select: { members: true, invites: true },
        },
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      organization: {
        id: "org-1",
        name: "Updated Org",
        slug: "updated-org",
        role: "OWNER",
        isMember: true,
        appEntitlements: [{ appKey: "thoughts", enabled: true }],
        featureEntitlements: [
          { appKey: "thoughts", featureKey: "adr", enabled: false },
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

  it("reflects the caller's own deny override in appAccess (ADR-030) after updating org settings", async () => {
    // Regression test: PATCH must load the caller's userAppOverrides, not
    // just appEntitlements — otherwise appAccess is computed against an
    // empty override set and can wrongly report access GET /api/orgs denies.
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockFindFirst.mockResolvedValue({ role: "OWNER" });
    mockUpdate.mockResolvedValue({
      id: "org-1",
      name: "Updated Org",
      slug: "updated-org",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: [{ role: "OWNER", createdAt: new Date("2026-04-04T00:00:00.000Z") }],
      appEntitlements: [{ appKey: "thoughts", enabled: true, accessMode: "ALL_MEMBERS" }],
      featureEntitlements: [],
      userAppOverrides: [{ appKey: "thoughts", enabled: false }],
      _count: { members: 3, invites: 0 },
    });

    const response = await PATCH(
      makeRequest({ name: "Updated Org", slug: "updated-org" }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      organization: { appAccess: Array<{ appKey: string; canAccess: boolean }> };
    };
    expect(body.organization.appAccess).toEqual([{ appKey: "thoughts", canAccess: false }]);
  });

  it("returns 409 when an updated name or slug conflicts", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockFindFirst.mockResolvedValue({ role: "OWNER" });
    mockUpdate.mockRejectedValue({ code: "P2002" });

    const response = await PATCH(
      makeRequest({ name: "Updated Org", slug: "updated-org" }),
      {
        params: Promise.resolve({ orgId: "org-1" }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "An organization with that name or slug already exists.",
    });
  });
});
