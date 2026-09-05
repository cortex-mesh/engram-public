import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockOrganizationFindUnique,
  mockUserCreate,
  mockUserFindFirst,
  mockHashPassword,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockOrganizationFindUnique: vi.fn(),
  mockUserCreate: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockHashPassword: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      findUnique: mockOrganizationFindUnique,
    },
    user: {
      create: mockUserCreate,
      findFirst: mockUserFindFirst,
    },
  },
}));

vi.mock("@/lib/password", () => ({
  hashPassword: mockHashPassword,
}));

import { POST } from "@/app/api/admin/users/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("https://platform.dev.ctxhost.com/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
  });

  it("forbids non-superadmins from creating users", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await POST(
      makeRequest({
        email: "roland@example.com",
        displayName: "Roland",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only platform superadmins can manage users.",
    });
  });

  it("validates required fields and optional membership payload", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await POST(
      makeRequest({
        email: "bad",
        displayName: "",
        orgId: "",
        orgRole: "NOPE",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "User creation requires a valid email, a display name, and an optional valid organization membership.",
    });
  });

  it("rejects malformed but @-containing email addresses", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await POST(
      makeRequest({
        email: "roland@",
        displayName: "Roland",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "User creation requires a valid email, a display name, and an optional valid organization membership.",
    });
  });

  it("returns a 400 when the request body is not valid JSON", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });

    const response = await POST(
      new NextRequest("https://platform.dev.ctxhost.com/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body.",
    });
  });

  it("creates a user with an initial organization membership", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "SUPERADMIN" });
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-1", name: "DBest", slug: "dbest" });
    mockUserFindFirst.mockResolvedValue(null);
    mockHashPassword.mockResolvedValue("hashed-password");
    mockUserCreate.mockResolvedValue({
      id: "user-2",
      email: "roland@example.com",
      username: "roland",
      displayName: "Roland Parnaso",
      role: "USER",
      createdAt: new Date("2026-04-22T12:00:00.000Z"),
      orgMembers: [
        {
          role: "OWNER",
          org: {
            id: "org-1",
            name: "DBest",
            slug: "dbest",
          },
        },
      ],
    });

    const response = await POST(
      makeRequest({
        email: "roland@example.com",
        displayName: "Roland Parnaso",
        orgId: "org-1",
        orgRole: "OWNER",
      }),
    );

    expect(mockOrganizationFindUnique).toHaveBeenCalledWith({
      where: { id: "org-1" },
      select: { id: true, name: true, slug: true },
    });
    expect(mockUserCreate).toHaveBeenCalledWith({
      data: {
        email: "roland@example.com",
        username: "roland",
        displayName: "Roland Parnaso",
        passwordHash: "hashed-password",
        emailVerified: true,
        role: "USER",
        orgMembers: {
          create: [
            {
              orgId: "org-1",
              role: "OWNER",
            },
          ],
        },
      },
      include: {
        orgMembers: {
          include: {
            org: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
      },
    });
    expect(response.status).toBe(201);

    const payload = await response.json();
    expect(payload.user).toEqual({
      id: "user-2",
      email: "roland@example.com",
      username: "roland",
      displayName: "Roland Parnaso",
      role: "USER",
      organizations: [
        {
          id: "org-1",
          name: "DBest",
          slug: "dbest",
          role: "OWNER",
        },
      ],
      createdAt: "2026-04-22T12:00:00.000Z",
    });
    expect(payload.temporaryPassword).toEqual(expect.any(String));
    expect(payload.temporaryPassword.length).toBeGreaterThanOrEqual(16);
  });
});
