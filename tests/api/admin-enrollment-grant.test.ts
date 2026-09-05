import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticate, mockGrant, mockCrossOrigin, mockFindUser } = vi.hoisted(() => ({ mockAuthenticate: vi.fn(), mockGrant: vi.fn(), mockCrossOrigin: vi.fn(), mockFindUser: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticate,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));
vi.mock("@/lib/enrollment", () => ({ grantEnrollment: mockGrant, EnrollmentInputError: class EnrollmentInputError extends Error {}, MAX_ENROLLMENT_LIFETIME_MS: 90 * 24 * 60 * 60 * 1000 }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("@/lib/organizations", () => ({ hasCrossOriginCookieWrite: mockCrossOrigin }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: mockFindUser } } }));

import { POST } from "@/app/api/admin/enrollments/route";

describe("POST /api/admin/enrollments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue({ userId: "admin-1", role: "SUPERADMIN" });
    mockCrossOrigin.mockReturnValue(false);
  });

  it.each([
    ["unauthenticated", undefined, false, 401],
    ["user", { userId: "user-1", role: "USER" }, false, 403],
    ["admin", { userId: "admin-1", role: "ADMIN" }, false, 403],
    ["internal", { userId: "internal", role: "ADMIN" }, false, 403],
    ["cross-origin cookie write", { userId: "admin-1", role: "SUPERADMIN" }, true, 403],
  ])("denies %s before granting enrollment", async (_name, auth, crossOrigin, expectedStatus) => {
    mockAuthenticate.mockResolvedValue(auth);
    mockCrossOrigin.mockReturnValue(crossOrigin);
    const response = await POST(new NextRequest("https://login.dev.ctxhost.com/api/admin/enrollments", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subjectId: "user-1", expiresAt: "2026-12-01T00:00:00.000Z" }),
    }));
    expect(response.status).toBe(expectedStatus);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it("rejects a grant beyond the 90-day admission window before mutation", async () => {
    const response = await POST(new NextRequest("https://login.dev.ctxhost.com/api/admin/enrollments", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subjectId: "user-1", expiresAt: "2126-01-01T00:00:00.000Z" }),
    }));
    expect(response.status).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", "\"grant\"", "42", "{"]) ("mutation-guards non-object grant body %s", async (body) => {
    const response = await POST(new NextRequest("https://login.dev.ctxhost.com/api/admin/enrollments", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }));
    expect(response.status).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
  });
});
