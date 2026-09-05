import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockOrgMemberFindFirst,
  mockUserFindUnique,
  mockUserFindFirst,
  mockMembershipCreate,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockOrgMemberFindFirst: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockMembershipCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/audit", () => ({ recordAuditEvent: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      findUnique: mockUserFindUnique,
    },
    user: {
      findFirst: mockUserFindFirst,
    },
    orgMember: {
      findFirst: mockOrgMemberFindFirst,
      create: mockMembershipCreate,
    },
  },
}));

import { POST } from "@/app/api/orgs/[orgId]/members/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("https://login.dev.ctxhost.com/api/orgs/org-1/members", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "engram-access=jwt-token",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/orgs/[orgId]/members", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("forbids non-members from adding org members", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    // Not a member of this org
    mockOrgMemberFindFirst.mockResolvedValue(null);

    const response = await POST(makeRequest({ email: "member@example.com", role: "MEMBER" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins or org owners/admins can access this resource.",
    });
  });

  it("validates member payloads", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await POST(makeRequest({ email: "bad", role: "NOPE" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Member management requires a valid email and org role.",
    });
  });

  it("does not allow explicit org membership creation for platform superadmins", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockUserFindUnique.mockResolvedValue({ id: "org-1" });
    mockUserFindFirst.mockResolvedValue({
      id: "user-2",
      email: "admin@ctxhost.com",
      username: "ctxhost-admin",
      displayName: "CTXHost Admin",
      role: "SUPERADMIN",
    });

    const response = await POST(makeRequest({ email: "admin@ctxhost.com", role: "OWNER" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(mockMembershipCreate).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Platform superadmins always retain implicit org access and should not be added explicitly.",
    });
  });

  it("adds an existing user to an organization with the requested role (SUPERADMIN caller includes email)", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockUserFindUnique.mockResolvedValue({ id: "org-1" });
    mockUserFindFirst.mockResolvedValue({
      id: "user-2",
      email: "member@example.com",
      username: "member",
      displayName: "Member User",
      role: "USER",
    });
    mockMembershipCreate.mockResolvedValue({
      role: "ADMIN",
      createdAt: new Date("2026-04-22T00:00:00.000Z"),
      user: {
        id: "user-2",
        email: "member@example.com",
        username: "member",
        displayName: "Member User",
        role: "USER",
      },
    });

    const response = await POST(makeRequest({ email: "member@example.com", role: "ADMIN" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(mockMembershipCreate).toHaveBeenCalledWith({
      data: {
        orgId: "org-1",
        userId: "user-2",
        role: "ADMIN",
      },
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
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      member: {
        id: "user-2",
        email: "member@example.com",
        username: "member",
        displayName: "Member User",
        platformRole: "USER",
        orgRole: "ADMIN",
        joinedAt: "2026-04-22T00:00:00.000Z",
      },
    });
  });
});
