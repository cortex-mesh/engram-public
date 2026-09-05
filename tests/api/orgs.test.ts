import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticateRequest, mockFindMany, mockFindFirst, mockCreate } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindFirst: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: {
      findMany: mockFindMany,
    },
    organization: {
      findFirst: mockFindFirst,
      create: mockCreate,
    },
  },
}));

import { isCurrentPlatformSuperadmin } from "@/lib/auth";
import { GET, POST } from "@/app/api/orgs/route";

function makeRequest(method: string, body?: Record<string, unknown>) {
  const request = new Request("https://engram.rapidagent.dev:8443/api/orgs", {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });

  return new NextRequest(request);
}

describe("/api/orgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("returns the authenticated user's organizations", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockFindMany.mockResolvedValue([
      {
        role: "OWNER",
        createdAt: new Date("2026-04-03T00:00:00.000Z"),
        org: {
          id: "org-1",
          name: "CORTEX",
          slug: "cortex",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-02T00:00:00.000Z"),
          appEntitlements: [
            {
              appKey: "thoughts",
              enabled: true,
              accessMode: "ALL_MEMBERS",
              updatedAt: new Date("2026-04-02T00:00:00.000Z"),
            },
          ],
          featureEntitlements: [
            { appKey: "thoughts", featureKey: "adr", enabled: false, updatedAt: new Date("2026-04-02T00:00:00.000Z") },
            { appKey: "thoughts", featureKey: "projects", enabled: true, updatedAt: new Date("2026-04-02T00:00:00.000Z") },
          ],
          userAppOverrides: [],
          invites: [{ createdAt: new Date("2026-04-01T12:00:00.000Z"), acceptedAt: null, revokedAt: null }],
          _count: { members: 2, invites: 1 },
        },
      },
    ]);

    const response = await GET(makeRequest("GET"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      organizations: [
        {
          id: "org-1",
          name: "CORTEX",
          slug: "cortex",
          role: "OWNER",
          isMember: true,
          appEntitlements: [{ appKey: "thoughts", enabled: true }],
          featureEntitlements: [
            { appKey: "thoughts", featureKey: "adr", enabled: false },
            { appKey: "thoughts", featureKey: "projects", enabled: true },
          ],
          userAppOverrides: [],
          appAccess: [{ appKey: "thoughts", canAccess: true }],
          memberCount: 2,
          pendingInviteCount: 1,
          latestActivityAt: "2026-04-03T00:00:00.000Z",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
      ],
    });
  });

  describe("appAccess (ADR-030)", () => {
    function mockGyrusMembership({
      role,
      accessMode,
      userAppOverrides = [],
    }: {
      role: string;
      accessMode: "ALL_MEMBERS" | "RESTRICTED";
      userAppOverrides?: Array<{ appKey: string; enabled: boolean }>;
    }) {
      mockFindMany.mockResolvedValue([
        {
          role,
          createdAt: new Date("2026-04-03T00:00:00.000Z"),
          org: {
            id: "org-1",
            name: "CORTEX",
            slug: "cortex",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
            updatedAt: new Date("2026-04-02T00:00:00.000Z"),
            appEntitlements: [
              {
                appKey: "gyrus",
                enabled: true,
                accessMode,
                updatedAt: new Date("2026-04-02T00:00:00.000Z"),
              },
            ],
            featureEntitlements: [],
            userAppOverrides,
            invites: [],
            _count: { members: 2, invites: 0 },
          },
        },
      ]);
    }

    async function getAppAccess() {
      const response = await GET(makeRequest("GET"));
      const body = (await response.json()) as {
        organizations: Array<{ appAccess: Array<{ appKey: string; canAccess: boolean }> }>;
      };
      return { status: response.status, appAccess: body.organizations[0]?.appAccess };
    }

    it("admits a MEMBER to an ALL_MEMBERS app with no override", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
      mockGyrusMembership({ role: "MEMBER", accessMode: "ALL_MEMBERS" });

      const { status, appAccess } = await getAppAccess();

      expect(status).toBe(200);
      expect(appAccess).toEqual([{ appKey: "gyrus", canAccess: true }]);
    });

    it("denies a MEMBER once the app flips to RESTRICTED with no allow-list row", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
      mockGyrusMembership({ role: "MEMBER", accessMode: "RESTRICTED" });

      const { status, appAccess } = await getAppAccess();

      expect(status).toBe(200);
      expect(appAccess).toEqual([{ appKey: "gyrus", canAccess: false }]);
    });

    it("admits a MEMBER on a RESTRICTED app once allow-listed via UserAppEntitlement", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
      mockGyrusMembership({
        role: "MEMBER",
        accessMode: "RESTRICTED",
        userAppOverrides: [{ appKey: "gyrus", enabled: true }],
      });

      const { status, appAccess } = await getAppAccess();

      expect(status).toBe(200);
      expect(appAccess).toEqual([{ appKey: "gyrus", canAccess: true }]);
    });

    it("admits an OWNER to a RESTRICTED app with no allow-list row", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
      mockGyrusMembership({ role: "OWNER", accessMode: "RESTRICTED" });

      const { status, appAccess } = await getAppAccess();

      expect(status).toBe(200);
      expect(appAccess).toEqual([{ appKey: "gyrus", canAccess: true }]);
    });

    it("admits a platform superadmin to a RESTRICTED app regardless of membership role or overrides", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
      mockGyrusMembership({ role: "MEMBER", accessMode: "RESTRICTED" });

      const { status, appAccess } = await getAppAccess();

      expect(status).toBe(200);
      expect(appAccess).toEqual([{ appKey: "gyrus", canAccess: true }]);
    });

    it("does not trust a stale SUPERADMIN JWT claim once the DB says the caller was demoted", async () => {
      // authenticateRequest reflects the 15-min access token's baked-in claim
      // (still SUPERADMIN); isCurrentPlatformSuperadmin is the fresh DB read
      // and must win (audit #9).
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
      vi.mocked(isCurrentPlatformSuperadmin).mockResolvedValueOnce(false);
      mockGyrusMembership({ role: "MEMBER", accessMode: "RESTRICTED" });

      const { status, appAccess } = await getAppAccess();

      expect(status).toBe(200);
      expect(appAccess).toEqual([{ appKey: "gyrus", canAccess: false }]);
    });

    it("never leaks another user's UserAppEntitlement row into the caller's appAccess", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
      mockGyrusMembership({ role: "MEMBER", accessMode: "RESTRICTED" });

      await getAppAccess();

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            org: expect.objectContaining({
              include: expect.objectContaining({
                userAppOverrides: expect.objectContaining({
                  where: { userId: "user-1" },
                }),
              }),
            }),
          }),
        }),
      );
    });
  });

  it("rejects internal API key auth for organization listing", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });

    const response = await GET(makeRequest("GET"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Internal API key auth is not allowed for organization management.",
    });
  });

  it("rejects unauthenticated requests", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);

    const response = await GET(makeRequest("GET"));

    expect(response.status).toBe(401);
  });

  it("validates new organization input before creating", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await POST(makeRequest("POST", { name: "X", slug: "Not Valid" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Organization name must be between 2 and 80 characters and slug must contain only lowercase letters, numbers, and hyphens.",
    });
  });

  it("forbids non-superadmins from creating organizations", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await POST(
      makeRequest("POST", { name: "Rapid Agent", slug: "rapid-agent" }),
    );

    expect(response.status).toBe(403);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins can create organizations.",
    });
  });

  it("forbids platform admins from creating organizations", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "ADMIN" });

    const response = await POST(
      makeRequest("POST", { name: "Rapid Agent", slug: "rapid-agent" }),
    );

    expect(response.status).toBe(403);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins can create organizations.",
    });
  });

  it("rejects cross-origin cookie-authenticated writes even when an authorization header is present", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await POST(
      new NextRequest("https://engram.rapidagent.dev:8443/api/orgs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://synapse.rapidagent.dev:8443",
          cookie: "engram-access=test-token",
          authorization: "Bearer not-the-auth-mechanism",
        },
        body: JSON.stringify({ name: "Rapid Agent", slug: "rapid-agent" }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin cookie-authenticated writes are not allowed.",
    });
  });

  it("allows same-origin cookie-authenticated writes when the public origin is trusted", async () => {
    process.env.ENGRAM_ALLOWED_ORIGINS = "https://login.ctxhost.com";
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: "org-forwarded",
      name: "CORTEX",
      slug: "cortex",
      createdAt: new Date("2026-04-21T21:00:00.000Z"),
      updatedAt: new Date("2026-04-21T21:00:00.000Z"),
      members: [{ role: "OWNER" }],
      appEntitlements: [],
      featureEntitlements: [],
      _count: { members: 1 },
    });

    const response = await POST(
      new NextRequest("http://127.0.0.1:3104/api/orgs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://login.ctxhost.com",
          cookie: "engram-access=test-token",
          host: "127.0.0.1:3104",
          "x-forwarded-host": "login.ctxhost.com",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({ name: "CORTEX", slug: "cortex" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalled();
  });

  it("rejects internal API key auth for organization creation", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });

    const response = await POST(
      makeRequest("POST", { name: "Rapid Agent", slug: "rapid-agent" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Internal API key auth is not allowed for organization management.",
    });
  });

  it("creates an organization for a platform superadmin without auto-adding the creator as a member", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: "org-2",
      name: "Rapid Agent",
      slug: "rapid-agent",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
      updatedAt: new Date("2026-04-03T00:00:00.000Z"),
      members: [],
      appEntitlements: [],
      featureEntitlements: [],
      _count: { members: 0 },
    });

    const response = await POST(
      makeRequest("POST", { name: "Rapid Agent", slug: "rapid-agent" }),
    );

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        name: "Rapid Agent",
        slug: "rapid-agent",
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
        invites: {
          where: { acceptedAt: null, revokedAt: null },
          select: { createdAt: true, acceptedAt: true, revokedAt: true },
        },
        _count: {
          select: { members: true, invites: true },
        },
      },
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      organization: {
        id: "org-2",
        name: "Rapid Agent",
        slug: "rapid-agent",
        role: "MEMBER",
        isMember: false,
        appEntitlements: [],
        featureEntitlements: [],
        userAppOverrides: [],
        appAccess: [],
        memberCount: 0,
        pendingInviteCount: 0,
        latestActivityAt: "2026-04-03T00:00:00.000Z",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:00:00.000Z",
      },
    });
  });

  it("returns 409 when the database reports a duplicate org name or slug", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockRejectedValue({ code: "P2002" });

    const response = await POST(
      makeRequest("POST", { name: "Rapid Agent", slug: "rapid-agent" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "An organization with that name or slug already exists.",
    });
  });
});
