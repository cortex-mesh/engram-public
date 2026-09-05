import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockOrgMemberFindFirst,
  mockOrganizationFindUnique,
  mockInviteFindFirst,
  mockInviteCreate,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockOrgMemberFindFirst: vi.fn(),
  mockOrganizationFindUnique: vi.fn(),
  mockInviteFindFirst: vi.fn(),
  mockInviteCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/audit", () => ({ recordAuditEvent: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      findUnique: mockOrganizationFindUnique,
    },
    orgMember: {
      findFirst: mockOrgMemberFindFirst,
    },
    orgInvite: {
      findFirst: mockInviteFindFirst,
      create: mockInviteCreate,
    },
  },
}));

import { POST } from "@/app/api/orgs/[orgId]/invites/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("https://login.dev.ctxhost.com/api/orgs/org-1/invites", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "engram-access=jwt-token",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/orgs/[orgId]/invites", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("forbids non-members from inviting org users", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    // Not a member of this org
    mockOrgMemberFindFirst.mockResolvedValue(null);

    const response = await POST(makeRequest({ email: "invitee@example.com", role: "MEMBER" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins or org owners/admins can access this resource.",
    });
  });

  it("validates invite payloads", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await POST(makeRequest({ email: "bad", role: "NOPE" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invite management requires a valid email and org role.",
    });
  });

  it("creates a pending invite for an organization", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-1" });
    mockInviteFindFirst.mockResolvedValue(null);
    mockInviteCreate.mockResolvedValue({
      id: "invite-1",
      email: "invitee@example.com",
      role: "ADMIN",
      createdAt: new Date("2026-04-23T05:00:00.000Z"),
      acceptedAt: null,
      revokedAt: null,
    });

    const response = await POST(makeRequest({ email: "invitee@example.com", role: "ADMIN" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(mockInviteCreate).toHaveBeenCalledWith({
      data: {
        orgId: "org-1",
        email: "invitee@example.com",
        role: "ADMIN",
        invitedByUserId: "user-1",
      },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      invite: {
        id: "invite-1",
        email: "invitee@example.com",
        role: "ADMIN",
        createdAt: "2026-04-23T05:00:00.000Z",
        acceptedAt: null,
        revokedAt: null,
      },
    });
  });

  it("returns 409 when the database reports a duplicate active invite", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-1" });
    mockInviteFindFirst.mockResolvedValue(null);
    mockInviteCreate.mockRejectedValue({ code: "P2002" });

    const response = await POST(makeRequest({ email: "invitee@example.com", role: "MEMBER" }), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "A pending invite for this email already exists.",
    });
  });
});
