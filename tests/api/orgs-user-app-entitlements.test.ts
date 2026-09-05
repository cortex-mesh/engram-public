import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockOrgMemberFindFirst,
  mockOrgMemberFindUnique,
  mockOrgAppFindUnique,
  mockUserFindUnique,
  mockUserOverrideFindUnique,
  mockUserOverrideFindMany,
  mockUserOverrideUpsert,
  mockUserOverrideDeleteMany,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockOrgMemberFindFirst: vi.fn(),
  mockOrgMemberFindUnique: vi.fn(),
  mockOrgAppFindUnique: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserOverrideFindUnique: vi.fn(),
  mockUserOverrideFindMany: vi.fn(),
  mockUserOverrideUpsert: vi.fn(),
  mockUserOverrideDeleteMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: {
      findFirst: mockOrgMemberFindFirst,
      findUnique: mockOrgMemberFindUnique,
    },
    orgAppEntitlement: { findUnique: mockOrgAppFindUnique },
    user: { findUnique: mockUserFindUnique },
    userAppEntitlement: {
      findUnique: mockUserOverrideFindUnique,
      findMany: mockUserOverrideFindMany,
      upsert: mockUserOverrideUpsert,
      deleteMany: mockUserOverrideDeleteMany,
    },
  },
}));

import { GET, PUT } from "@/app/api/orgs/[orgId]/users/[userId]/app-entitlements/route";
import { DELETE } from "@/app/api/orgs/[orgId]/users/[userId]/app-entitlements/[appKey]/route";
import { GET as listForApp } from "@/app/api/orgs/[orgId]/app-entitlements/[appKey]/users/route";

const FIXED_DATE = new Date("2026-04-29T12:00:00.000Z");

function makeRequest(method: string, body?: Record<string, unknown>) {
  const url =
    "https://engram.rapidagent.dev:8443/api/orgs/org-1/users/user-2/app-entitlements";
  return new NextRequest(
    new Request(url, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "Content-Type": "application/json" } : undefined,
    }),
  );
}

describe("user app entitlement routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
    // Default: the target user IS a member of the org. Tests that probe the
    // non-member path override this with mockResolvedValue(null).
    mockOrgMemberFindUnique.mockResolvedValue({ id: "membership-1" });
  });

  describe("GET /api/orgs/[orgId]/users/[userId]/app-entitlements", () => {
    it("lists overrides for SUPERADMIN", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });
      mockUserOverrideFindMany.mockResolvedValue([
        {
          appKey: "pulse",
          enabled: false,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
          createdByUserId: "admin-1",
          updatedByUserId: "admin-1",
        },
      ]);

      const response = await GET(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      });

      expect(response.status).toBe(200);
      expect(mockOrgMemberFindFirst).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({
        userAppEntitlements: [
          {
            appKey: "pulse",
            enabled: false,
            createdAt: "2026-04-29T12:00:00.000Z",
            updatedAt: "2026-04-29T12:00:00.000Z",
            createdByUserId: "admin-1",
            updatedByUserId: "admin-1",
          },
        ],
      });
    });

    it("lists overrides for an OWNER of the org", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "owner-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
      mockUserOverrideFindMany.mockResolvedValue([]);

      const response = await GET(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      });

      expect(response.status).toBe(200);
      expect(mockOrgMemberFindFirst).toHaveBeenCalledWith({
        where: { orgId: "org-1", userId: "owner-1" },
        select: { role: true },
      });
    });

    it("forbids MEMBERs of the org", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "member-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue({ role: "MEMBER" });

      const response = await GET(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      });

      expect(response.status).toBe(403);
      expect(mockUserOverrideFindMany).not.toHaveBeenCalled();
    });

    it("forbids non-members of the org", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "stranger-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue(null);

      const response = await GET(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      });

      expect(response.status).toBe(403);
    });

    it("returns 404 when the TARGET user is not a member of the org", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });
      mockOrgMemberFindUnique.mockResolvedValue(null);

      const response = await GET(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", userId: "outsider" }),
      });

      expect(response.status).toBe(404);
      expect(mockUserOverrideFindMany).not.toHaveBeenCalled();
    });

    it("rejects internal API key auth", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "internal",
        role: "ADMIN",
      });

      const response = await GET(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error:
          "Internal API key auth is not allowed for organization management.",
      });
    });

    it("returns 401 for unauthenticated requests", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);

      const response = await GET(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("PUT /api/orgs/[orgId]/users/[userId]/app-entitlements", () => {
    it("upserts an override for SUPERADMIN without org-app gate", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });
      mockUserFindUnique.mockResolvedValue({ id: "user-2" });
      mockUserOverrideFindUnique.mockResolvedValue(null);
      mockUserOverrideUpsert.mockResolvedValue({
        appKey: "pulse",
        enabled: false,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
        createdByUserId: "admin-1",
        updatedByUserId: "admin-1",
      });

      const response = await PUT(
        makeRequest("PUT", { appKey: "pulse", enabled: false }),
        { params: Promise.resolve({ orgId: "org-1", userId: "user-2" }) },
      );

      expect(response.status).toBe(200);
      expect(mockOrgAppFindUnique).not.toHaveBeenCalled();
      expect(mockUserOverrideUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_orgId_appKey: {
              userId: "user-2",
              orgId: "org-1",
              appKey: "pulse",
            },
          },
          create: expect.objectContaining({
            userId: "user-2",
            orgId: "org-1",
            appKey: "pulse",
            enabled: false,
            createdByUserId: "admin-1",
            updatedByUserId: "admin-1",
          }),
        }),
      );
    });

    it("requires the org to have the app entitled when caller is OWNER (not SUPERADMIN)", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "owner-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
      mockOrgAppFindUnique.mockResolvedValue(null);

      const response = await PUT(
        makeRequest("PUT", { appKey: "pulse", enabled: false }),
        { params: Promise.resolve({ orgId: "org-1", userId: "user-2" }) },
      );

      expect(response.status).toBe(400);
      expect(mockUserOverrideUpsert).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({
        error:
          "Organization owners and admins can only manage per-user overrides for apps the org has enabled.",
      });
    });

    it("rejects an OWNER when the org has the app row but enabled=false", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "owner-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
      mockOrgAppFindUnique.mockResolvedValue({ enabled: false });

      const response = await PUT(
        makeRequest("PUT", { appKey: "pulse", enabled: false }),
        { params: Promise.resolve({ orgId: "org-1", userId: "user-2" }) },
      );

      expect(response.status).toBe(400);
      expect(mockUserOverrideUpsert).not.toHaveBeenCalled();
    });

    it("validates appKey", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });

      const response = await PUT(
        makeRequest("PUT", { appKey: "not-a-real-app", enabled: false }),
        { params: Promise.resolve({ orgId: "org-1", userId: "user-2" }) },
      );

      expect(response.status).toBe(400);
    });

    it("validates enabled is boolean", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });

      const response = await PUT(
        makeRequest("PUT", { appKey: "pulse", enabled: "false" }),
        { params: Promise.resolve({ orgId: "org-1", userId: "user-2" }) },
      );

      expect(response.status).toBe(400);
    });

    it("returns 404 when the target user is not a member of the org (even for SUPERADMIN)", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });
      mockOrgMemberFindUnique.mockResolvedValue(null);

      const response = await PUT(
        makeRequest("PUT", { appKey: "pulse", enabled: false }),
        { params: Promise.resolve({ orgId: "org-1", userId: "outsider" }) },
      );

      expect(response.status).toBe(404);
      expect(mockUserOverrideUpsert).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({
        error: "User is not a member of this organization.",
      });
    });

    it("forbids an OWNER from writing an override for a user in another org", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "owner-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
      mockOrgAppFindUnique.mockResolvedValue({ enabled: true });
      mockOrgMemberFindUnique.mockResolvedValue(null); // target not in org-1

      const response = await PUT(
        makeRequest("PUT", { appKey: "pulse", enabled: true }),
        { params: Promise.resolve({ orgId: "org-1", userId: "victim-in-org-2" }) },
      );

      expect(response.status).toBe(404);
      expect(mockUserOverrideUpsert).not.toHaveBeenCalled();
    });

    it("rejects cross-origin cookie writes", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });

      const response = await PUT(
        new NextRequest(
          "https://engram.rapidagent.dev:8443/api/orgs/org-1/users/user-2/app-entitlements",
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              origin: "https://attacker.example.com",
              cookie: "engram-access=stolen",
            },
            body: JSON.stringify({ appKey: "pulse", enabled: false }),
          },
        ),
        { params: Promise.resolve({ orgId: "org-1", userId: "user-2" }) },
      );

      expect(response.status).toBe(403);
      expect(mockUserOverrideUpsert).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/orgs/[orgId]/users/[userId]/app-entitlements/[appKey]", () => {
    it("removes the override for SUPERADMIN", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });
      mockUserOverrideDeleteMany.mockResolvedValue({ count: 1 });

      const response = await DELETE(makeRequest("DELETE"), {
        params: Promise.resolve({
          orgId: "org-1",
          userId: "user-2",
          appKey: "pulse",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockUserOverrideDeleteMany).toHaveBeenCalledWith({
        where: { orgId: "org-1", userId: "user-2", appKey: "pulse" },
      });
    });

    it("returns 404 when no override exists", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });
      mockUserOverrideDeleteMany.mockResolvedValue({ count: 0 });

      const response = await DELETE(makeRequest("DELETE"), {
        params: Promise.resolve({
          orgId: "org-1",
          userId: "user-2",
          appKey: "pulse",
        }),
      });

      expect(response.status).toBe(404);
    });

    it("rejects MEMBERs", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "member-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue({ role: "MEMBER" });

      const response = await DELETE(makeRequest("DELETE"), {
        params: Promise.resolve({
          orgId: "org-1",
          userId: "user-2",
          appKey: "pulse",
        }),
      });

      expect(response.status).toBe(403);
      expect(mockUserOverrideDeleteMany).not.toHaveBeenCalled();
    });

    it("rejects an unknown app key", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });

      const response = await DELETE(makeRequest("DELETE"), {
        params: Promise.resolve({
          orgId: "org-1",
          userId: "user-2",
          appKey: "imaginary-app",
        }),
      });

      expect(response.status).toBe(400);
      expect(mockUserOverrideDeleteMany).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/orgs/[orgId]/app-entitlements/[appKey]/users", () => {
    it("lists users with overrides for SUPERADMIN", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "admin-1",
        role: "SUPERADMIN",
      });
      mockUserOverrideFindMany.mockResolvedValue([
        {
          appKey: "pulse",
          enabled: false,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
          createdByUserId: "admin-1",
          updatedByUserId: "admin-1",
          user: {
            id: "user-2",
            email: "bob@example.com",
            username: "bob",
            displayName: "Bob",
          },
        },
      ]);

      const response = await listForApp(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", appKey: "pulse" }),
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        userAppEntitlements: Array<{ user: { username: string }; enabled: boolean }>;
      };
      expect(json.userAppEntitlements).toHaveLength(1);
      expect(json.userAppEntitlements[0].user.username).toBe("bob");
      expect(json.userAppEntitlements[0].enabled).toBe(false);
      // Identity fields only come from rows whose user is still a member
      expect(mockUserOverrideFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orgId: "org-1",
            appKey: "pulse",
            user: { orgMembers: { some: { orgId: "org-1" } } },
          }),
        }),
      );
    });

    it("forbids MEMBERs of the org", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "member-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue({ role: "MEMBER" });

      const response = await listForApp(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", appKey: "pulse" }),
      });

      expect(response.status).toBe(403);
      expect(mockUserOverrideFindMany).not.toHaveBeenCalled();
    });

    it("rejects an OWNER when the org does not have the app entitled", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        userId: "owner-1",
        role: "USER",
      });
      mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
      mockOrgAppFindUnique.mockResolvedValue(null);

      const response = await listForApp(makeRequest("GET"), {
        params: Promise.resolve({ orgId: "org-1", appKey: "pulse" }),
      });

      expect(response.status).toBe(400);
      expect(mockUserOverrideFindMany).not.toHaveBeenCalled();
    });
  });
});
