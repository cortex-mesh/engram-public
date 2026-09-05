import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockMembershipFindFirst,
  mockMembershipCount,
  mockMembershipUpdate,
  mockMembershipDelete,
  mockOverrideDelete,
  mockTransaction,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockMembershipFindFirst: vi.fn(),
  mockMembershipCount: vi.fn(),
  mockMembershipUpdate: vi.fn(),
  mockMembershipDelete: vi.fn(),
  mockOverrideDelete: vi.fn(),
  mockTransaction: vi.fn((ops) => Promise.all(ops)),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
    orgMember: {
      findFirst: mockMembershipFindFirst,
      count: mockMembershipCount,
      update: mockMembershipUpdate,
      deleteMany: mockMembershipDelete,
    },
    userAppEntitlement: {
      deleteMany: mockOverrideDelete,
    },
  },
}));

import { PATCH, DELETE } from "../../src/app/api/orgs/[orgId]/members/[userId]/route";

function makePatchRequest(body: Record<string, unknown>) {
  return new NextRequest("https://login.dev.ctxhost.com/api/orgs/org-1/members/user-2", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("org member management detail routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("prevents demoting the last organization manager to member", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockMembershipFindFirst.mockResolvedValue({ id: "membership-1", role: "OWNER", user: { role: "USER" } });
    mockMembershipCount.mockResolvedValue(1);

    const response = (await PATCH(makePatchRequest({ role: "MEMBER" }), {
      params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
    }))!;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "An organization must keep at least one owner or admin.",
    });
  });

  it("prevents changing a platform superadmin org membership", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockMembershipFindFirst.mockResolvedValue({ id: "membership-1", role: "OWNER", user: { role: "SUPERADMIN" } });

    const response = (await PATCH(makePatchRequest({ role: "MEMBER" }), {
      params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
    }))!;

    expect(mockMembershipUpdate).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Platform superadmins always retain implicit org access and cannot be changed here.",
    });
  });

  it("updates an org member role for superadmins", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockMembershipFindFirst.mockResolvedValue({ id: "membership-1", role: "ADMIN", user: { role: "USER" } });
    mockMembershipCount.mockResolvedValue(2);
    mockMembershipUpdate.mockResolvedValue({
      role: "OWNER",
      createdAt: new Date("2026-04-22T00:00:00.000Z"),
      user: {
        id: "user-2",
        email: "owner@example.com",
        username: "owner",
        displayName: "Owner User",
        role: "USER",
      },
    });

    const response = (await PATCH(makePatchRequest({ role: "OWNER" }), {
      params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
    }))!;

    expect(mockMembershipUpdate).toHaveBeenCalledWith({
      where: { id: "membership-1", orgId: "org-1" },
      data: { role: "OWNER" },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            displayName: true,
            role: true,
          },
        },
      },
    });
    expect(response.status).toBe(200);
  });

  it("prevents removing the last organization manager", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockMembershipFindFirst.mockResolvedValue({ role: "OWNER", user: { role: "USER" } });
    mockMembershipCount.mockResolvedValue(1);

    const response = (await DELETE(
      new NextRequest("https://login.dev.ctxhost.com/api/orgs/org-1/members/user-2", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      },
    ))!;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "An organization must keep at least one owner or admin.",
    });
  });

  it("prevents removing a platform superadmin org membership", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockMembershipFindFirst.mockResolvedValue({ role: "OWNER", user: { role: "SUPERADMIN" } });

    const response = (await DELETE(
      new NextRequest("https://login.dev.ctxhost.com/api/orgs/org-1/members/user-2", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      },
    ))!;

    expect(mockMembershipDelete).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Platform superadmins always retain implicit org access and cannot be changed here.",
    });
  });

  it("removes an org member and their per-org entitlement overrides for superadmins", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockMembershipFindFirst.mockResolvedValue({ role: "MEMBER", user: { role: "USER" } });
    mockMembershipDelete.mockResolvedValue({ count: 1 });
    mockOverrideDelete.mockResolvedValue({ count: 2 });

    const response = (await DELETE(
      new NextRequest("https://login.dev.ctxhost.com/api/orgs/org-1/members/user-2", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({ orgId: "org-1", userId: "user-2" }),
      },
    ))!;

    expect(mockMembershipDelete).toHaveBeenCalledWith({
      where: { orgId: "org-1", userId: "user-2" },
    });
    // Per-org overrides are purged in the same transaction (no orphan rows)
    expect(mockOverrideDelete).toHaveBeenCalledWith({
      where: { orgId: "org-1", userId: "user-2" },
    });
    expect(mockTransaction).toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });
});
