import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockUserFindUnique,
  mockUserUpdate,
  mockOrgMemberFindMany,
  mockOrgFindUnique,
  mockOrgAppEntitlementFindMany,
  mockUserAppEntitlementFindMany,
  mockOrgAppFeatureEntitlementFindMany,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockOrgMemberFindMany: vi.fn(),
  mockOrgFindUnique: vi.fn(),
  mockOrgAppEntitlementFindMany: vi.fn(),
  mockUserAppEntitlementFindMany: vi.fn(),
  mockOrgAppFeatureEntitlementFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
    orgMember: { findMany: mockOrgMemberFindMany },
    organization: { findUnique: mockOrgFindUnique },
    orgAppEntitlement: { findMany: mockOrgAppEntitlementFindMany },
    userAppEntitlement: { findMany: mockUserAppEntitlementFindMany },
    orgAppFeatureEntitlement: {
      findMany: mockOrgAppFeatureEntitlementFindMany,
    },
  },
}));

import { GET, OPTIONS } from "@/app/api/me/app-switcher/route";

function makeRequest(
  url = "https://login.dev.ctxhost.com/api/me/app-switcher",
  init: RequestInit = {},
) {
  return new NextRequest(new Request(url, { method: "GET", ...init }));
}

const USER_ROW = {
  id: "user-1",
  email: "roland@ctxhost.com",
  displayName: "Roland",
  avatarUrl: null,
  role: "USER",
  lastOrgId: null,
};

const ORG_CORTEX = { id: "org-1", slug: "cortex", name: "CORTEX" };
const ORG_ACME = { id: "org-2", slug: "acme", name: "Acme" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";
  process.env.ENGRAM_ALLOWED_ORIGINS = "";
  // Default: org has no enabled feature rows (features are default-deny).
  mockOrgAppFeatureEntitlementFindMany.mockResolvedValue([]);
  // Default: user.update() is a no-op (best-effort lastOrgId write).
  mockUserUpdate.mockResolvedValue({});
});

describe("GET /api/me/app-switcher", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("rejects internal API key auth", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "internal",
      role: "ADMIN",
    });
    const response = await GET(makeRequest());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Internal API key auth is not allowed for the app switcher.",
    });
  });

  it("returns 401 when the JWT's user no longer exists", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(null);
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
  });

  it("returns entitled apps for an org member (org-only, no overrides)", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([
      { appKey: "pulse" },
      { appKey: "synapse" },
    ]);
    mockUserAppEntitlementFindMany.mockResolvedValue([]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toEqual({
      id: "user-1",
      displayName: "Roland",
      email: "roland@ctxhost.com",
      avatarUrl: null,
      role: "USER",
    });
    expect(body.org).toEqual({
      id: "org-1",
      slug: "cortex",
      displayName: "CORTEX",
    });
    expect(body.orgs).toEqual([
      { id: "org-1", slug: "cortex", displayName: "CORTEX" },
    ]);
    expect(body.apps.map((a: { key: string }) => a.key).sort()).toEqual([
      "pulse",
      "synapse",
    ]);
    expect(body.apps[0]).toMatchObject({
      key: expect.any(String),
      label: expect.any(String),
      description: expect.any(String),
      url: expect.any(String),
      icon: expect.any(String),
    });
  });

  it("returns entitled apps for a plain MEMBER (no role gate on the read path)", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "thoughts" }]);
    mockUserAppEntitlementFindMany.mockResolvedValue([]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.apps.map((a: { key: string }) => a.key)).toEqual(["thoughts"]);
  });

  it("builds org-aware product app URLs on the active org's tenant host", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_ACME }]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "synapse" }]);
    mockUserAppEntitlementFindMany.mockResolvedValue([]);

    const response = await GET(
      makeRequest("https://acme.dev.ctxhost.com/api/me/app-switcher", {
        headers: { origin: "https://acme.dev.ctxhost.com" },
      }),
    );
    const body = await response.json();
    const synapse = body.apps.find((a: { key: string }) => a.key === "synapse");
    // Not the hardcoded cortex host — the active org's tenant host.
    expect(synapse.url).toBe("https://acme.dev.ctxhost.com/synapse");
  });

  it("defaults the active org to the request Origin host's tenant", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    // Member of cortex (oldest, the legacy default) AND acme — the Origin
    // host hint should pick acme, not memberOrgs[0].
    mockOrgMemberFindMany.mockResolvedValue([
      { org: ORG_CORTEX },
      { org: ORG_ACME },
    ]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "synapse" }]);
    mockUserAppEntitlementFindMany.mockResolvedValue([]);

    const response = await GET(
      makeRequest("https://acme.dev.ctxhost.com/api/me/app-switcher", {
        headers: { origin: "https://acme.dev.ctxhost.com" },
      }),
    );
    const body = await response.json();
    expect(body.org).toEqual({
      id: "org-2",
      slug: "acme",
      displayName: "Acme",
    });
  });

  it("falls back to first membership for a non-tenant Origin (login host)", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([
      { org: ORG_CORTEX },
      { org: ORG_ACME },
    ]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "synapse" }]);
    mockUserAppEntitlementFindMany.mockResolvedValue([]);

    const response = await GET(
      makeRequest("https://login.dev.ctxhost.com/api/me/app-switcher", {
        headers: { origin: "https://login.dev.ctxhost.com" },
      }),
    );
    const body = await response.json();
    expect(body.org.slug).toBe("cortex");
  });

  it("excludes an app the user has an explicit per-user deny on", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([
      { appKey: "pulse" },
      { appKey: "synapse" },
    ]);
    mockUserAppEntitlementFindMany.mockResolvedValue([
      { appKey: "pulse", enabled: false },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.apps.map((a: { key: string }) => a.key)).toEqual(["synapse"]);
  });

  it("ignores per-user rows where enabled is not strictly false", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "pulse" }]);
    mockUserAppEntitlementFindMany.mockResolvedValue([
      { appKey: "pulse", enabled: true },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.apps.map((a: { key: string }) => a.key)).toEqual(["pulse"]);
  });

  it("returns all catalog apps for SUPERADMIN, bypassing entitlement queries", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "SUPERADMIN",
    });
    mockUserFindUnique.mockResolvedValue({ ...USER_ROW, role: "SUPERADMIN" });
    mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    // DB enum value for the tenant-shell entry is "dashboard"; the
    // user-facing switcher surfaces it as "nexus" with a per-tenant URL.
    expect(body.apps.map((a: { key: string }) => a.key)).toEqual([
      "nexus",
      "synapse",
      "thoughts",
      "axon",
      "pulse",
      "gyrus",
    ]);
    const nexusEntry = body.apps.find(
      (a: { key: string }) => a.key === "nexus",
    );
    expect(nexusEntry).toMatchObject({
      key: "nexus",
      label: "Nexus",
      url: "https://cortex.dev.ctxhost.com/",
    });
    expect(mockOrgAppEntitlementFindMany).not.toHaveBeenCalled();
    expect(mockUserAppEntitlementFindMany).not.toHaveBeenCalled();
  });

  it("returns apps for SUPERADMIN even when they're not a member of the requested org", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "SUPERADMIN",
    });
    mockUserFindUnique.mockResolvedValue({ ...USER_ROW, role: "SUPERADMIN" });
    mockOrgMemberFindMany.mockResolvedValue([]);
    mockOrgFindUnique.mockResolvedValue(ORG_ACME);

    const response = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/me/app-switcher?org=org-2",
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.org).toEqual({
      id: "org-2",
      slug: "acme",
      displayName: "Acme",
    });
    expect(body.orgs).toEqual([]);
    expect(body.apps.length).toBe(6);
  });

  it("returns 404 when SUPERADMIN requests a missing org", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "SUPERADMIN",
    });
    mockUserFindUnique.mockResolvedValue({ ...USER_ROW, role: "SUPERADMIN" });
    mockOrgMemberFindMany.mockResolvedValue([]);
    mockOrgFindUnique.mockResolvedValue(null);

    const response = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/me/app-switcher?org=missing",
      ),
    );
    expect(response.status).toBe(404);
  });

  it("returns 403 when a non-member non-SUPERADMIN requests another org", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);

    const response = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/me/app-switcher?org=org-2",
      ),
    );
    expect(response.status).toBe(403);
    expect(mockOrgAppEntitlementFindMany).not.toHaveBeenCalled();
  });

  it("returns empty switcher for a user with no org memberships", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.org).toBeNull();
    expect(body.orgs).toEqual([]);
    expect(body.apps).toEqual([]);
  });

  it("honors the requested org when the user belongs to multiple orgs", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([
      { org: ORG_CORTEX },
      { org: ORG_ACME },
    ]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "thoughts" }]);
    mockUserAppEntitlementFindMany.mockResolvedValue([]);

    const response = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/me/app-switcher?org=org-2",
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.org).toEqual({
      id: "org-2",
      slug: "acme",
      displayName: "Acme",
    });
    expect(body.orgs).toHaveLength(2);
    expect(body.apps.map((a: { key: string }) => a.key)).toEqual(["thoughts"]);
    expect(mockOrgAppEntitlementFindMany).toHaveBeenCalledWith({
      where: { orgId: "org-2", enabled: true },
      select: { appKey: true },
    });
  });

  it("falls back to the first org by createdAt when no org is requested", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockResolvedValue(USER_ROW);
    mockOrgMemberFindMany.mockResolvedValue([
      { org: ORG_CORTEX },
      { org: ORG_ACME },
    ]);
    mockOrgAppEntitlementFindMany.mockResolvedValue([]);
    mockUserAppEntitlementFindMany.mockResolvedValue([]);

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.org).toEqual({
      id: "org-1",
      slug: "cortex",
      displayName: "CORTEX",
    });
    expect(mockOrgMemberFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "asc" },
      include: { org: { select: { id: true, slug: true, name: true } } },
    });
  });

  describe("per-app features (cortex ADR-104 amendment — command palette)", () => {
    function appByKey(body: { apps: Array<{ key: string }> }, key: string) {
      return body.apps.find((a) => a.key === key) as
        | {
            key: string;
            features: Array<{ key: string; name: string; url: string }>;
          }
        | undefined;
    }

    it("returns the org's enabled features (default-deny) for an entitled member", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "user-1",
        role: "USER",
      });
      mockUserFindUnique.mockResolvedValue(USER_ROW);
      mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);
      mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "thoughts" }]);
      mockUserAppEntitlementFindMany.mockResolvedValue([]);
      // Only "projects" is enabled for this org; "adr" has no enabled row.
      mockOrgAppFeatureEntitlementFindMany.mockResolvedValue([
        { appKey: "thoughts", featureKey: "projects" },
      ]);

      const response = await GET(makeRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(mockOrgAppFeatureEntitlementFindMany).toHaveBeenCalledWith({
        where: { orgId: "org-1", enabled: true },
        select: { appKey: true, featureKey: true },
      });
      const thoughts = appByKey(body, "thoughts");
      expect(thoughts).toBeDefined();
      expect(thoughts!.features.map((f) => f.key)).toEqual(["projects"]);
      expect(thoughts!.features[0]).toMatchObject({
        key: "projects",
        name: "Projects",
      });
      // projects has an empty path -> resolves to the app root.
      expect(thoughts!.features[0].url).toBe(
        "https://cortex.dev.ctxhost.com/thoughts",
      );
    });

    it("omits features that have no enabled row", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "user-1",
        role: "USER",
      });
      mockUserFindUnique.mockResolvedValue(USER_ROW);
      mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);
      mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "thoughts" }]);
      mockUserAppEntitlementFindMany.mockResolvedValue([]);
      mockOrgAppFeatureEntitlementFindMany.mockResolvedValue([]);

      const response = await GET(makeRequest());
      const body = await response.json();
      expect(appByKey(body, "thoughts")!.features).toEqual([]);
    });

    it("gives a SUPERADMIN every catalog feature with resolved urls", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "user-1",
        role: "SUPERADMIN",
      });
      mockUserFindUnique.mockResolvedValue({ ...USER_ROW, role: "SUPERADMIN" });
      mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);

      const response = await GET(makeRequest());
      const body = await response.json();
      const thoughts = appByKey(body, "thoughts");
      expect(thoughts!.features.map((f) => f.key).sort()).toEqual([
        "adr",
        "projects",
      ]);
      expect(thoughts!.features.find((f) => f.key === "adr")!.url).toBe(
        "https://cortex.dev.ctxhost.com/thoughts/adrs",
      );
      // Apps without catalog features expose an empty list.
      expect(appByKey(body, "synapse")!.features).toEqual([]);
      expect(mockOrgAppFeatureEntitlementFindMany).not.toHaveBeenCalled();
    });
  });

  describe("CORS (cortex ADR-102 §D6)", () => {
    it("OPTIONS preflight from a trusted origin returns 204 with CORS headers", async () => {
      process.env.ENGRAM_ALLOWED_ORIGINS = "https://cortex.dev.ctxhost.com";

      const response = await OPTIONS(
        makeRequest("https://login.dev.ctxhost.com/api/me/app-switcher", {
          method: "OPTIONS",
          headers: { origin: "https://cortex.dev.ctxhost.com" },
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://cortex.dev.ctxhost.com",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
      expect(response.headers.get("vary")).toBe("Origin");
    });

    it("OPTIONS preflight from an untrusted origin returns 204 without CORS headers", async () => {
      const response = await OPTIONS(
        makeRequest("https://login.dev.ctxhost.com/api/me/app-switcher", {
          method: "OPTIONS",
          headers: { origin: "https://evil.example.com" },
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("GET from a trusted origin echoes CORS headers on the JSON response", async () => {
      process.env.ENGRAM_ALLOWED_ORIGINS = "https://cortex.dev.ctxhost.com";
      mockAuthenticateRequest.mockResolvedValue({
        userId: "user-1",
        role: "USER",
      });
      mockUserFindUnique.mockResolvedValue(USER_ROW);
      mockOrgMemberFindMany.mockResolvedValue([{ org: ORG_CORTEX }]);
      mockOrgAppEntitlementFindMany.mockResolvedValue([]);
      mockUserAppEntitlementFindMany.mockResolvedValue([]);

      const response = await GET(
        makeRequest("https://login.dev.ctxhost.com/api/me/app-switcher", {
          headers: { origin: "https://cortex.dev.ctxhost.com" },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://cortex.dev.ctxhost.com",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
    });

    it("GET from an untrusted origin returns no CORS headers (browser will block)", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "user-1",
        role: "USER",
      });
      mockUserFindUnique.mockResolvedValue(USER_ROW);
      mockOrgMemberFindMany.mockResolvedValue([]);

      const response = await GET(
        makeRequest("https://login.dev.ctxhost.com/api/me/app-switcher", {
          headers: { origin: "https://evil.example.com" },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("401 responses also carry CORS headers when the origin is trusted (so the browser surfaces the error to JS)", async () => {
      process.env.ENGRAM_ALLOWED_ORIGINS = "https://cortex.dev.ctxhost.com";
      mockAuthenticateRequest.mockResolvedValue(null);

      const response = await GET(
        makeRequest("https://login.dev.ctxhost.com/api/me/app-switcher", {
          headers: { origin: "https://cortex.dev.ctxhost.com" },
        }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://cortex.dev.ctxhost.com",
      );
    });
  });

  it("returns 500 when the database throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-1",
      role: "USER",
    });
    mockUserFindUnique.mockRejectedValue(new Error("db down"));

    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
    consoleError.mockRestore();
  });

  describe("lastOrgId persistence (most-recently-used org)", () => {
    it("records lastOrgId when request comes from a tenant host and it differs from stored", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
      mockUserFindUnique.mockResolvedValue({ ...USER_ROW, lastOrgId: null });
      mockOrgMemberFindMany.mockResolvedValue([
        { org: ORG_CORTEX },
        { org: ORG_ACME },
      ]);
      mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "synapse" }]);
      mockUserAppEntitlementFindMany.mockResolvedValue([]);

      await GET(
        makeRequest("https://acme.dev.ctxhost.com/api/me/app-switcher", {
          headers: { origin: "https://acme.dev.ctxhost.com" },
        }),
      );

      // Flush the fire-and-forget promise
      await Promise.resolve();
      expect(mockUserUpdate).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { lastOrgId: "org-2" },
      });
    });

    it("does not record lastOrgId when it already matches", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
      mockUserFindUnique.mockResolvedValue({ ...USER_ROW, lastOrgId: "org-2" });
      mockOrgMemberFindMany.mockResolvedValue([
        { org: ORG_CORTEX },
        { org: ORG_ACME },
      ]);
      mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "synapse" }]);
      mockUserAppEntitlementFindMany.mockResolvedValue([]);

      await GET(
        makeRequest("https://acme.dev.ctxhost.com/api/me/app-switcher", {
          headers: { origin: "https://acme.dev.ctxhost.com" },
        }),
      );

      await Promise.resolve();
      expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it("does not record lastOrgId for an off-tenant origin (login host fallback)", async () => {
      mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
      mockUserFindUnique.mockResolvedValue({ ...USER_ROW, lastOrgId: null });
      mockOrgMemberFindMany.mockResolvedValue([
        { org: ORG_CORTEX },
        { org: ORG_ACME },
      ]);
      mockOrgAppEntitlementFindMany.mockResolvedValue([{ appKey: "synapse" }]);
      mockUserAppEntitlementFindMany.mockResolvedValue([]);

      await GET(
        makeRequest("https://login.dev.ctxhost.com/api/me/app-switcher", {
          headers: { origin: "https://login.dev.ctxhost.com" },
        }),
      );

      await Promise.resolve();
      expect(mockUserUpdate).not.toHaveBeenCalled();
    });
  });
});
