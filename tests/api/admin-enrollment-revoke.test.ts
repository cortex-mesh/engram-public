import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticate, mockRevoke, mockCrossOrigin } = vi.hoisted(() => ({ mockAuthenticate: vi.fn(), mockRevoke: vi.fn(), mockCrossOrigin: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticate,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));
vi.mock("@/lib/enrollment", () => ({
  revokeEnrollment: mockRevoke,
  EnrollmentNotFoundError: class EnrollmentNotFoundError extends Error {},
}));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("@/lib/organizations", () => ({ hasCrossOriginCookieWrite: mockCrossOrigin }));

import { DELETE } from "@/app/api/admin/enrollments/[subjectId]/route";

describe("DELETE /api/admin/enrollments/[subjectId]", () => {
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
  ])("denies %s before revoking enrollment", async (_name, auth, crossOrigin, expectedStatus) => {
    mockAuthenticate.mockResolvedValue(auth);
    mockCrossOrigin.mockReturnValue(crossOrigin);
    const response = await DELETE(new NextRequest("https://login.dev.ctxhost.com/api/admin/enrollments/user-1", { method: "DELETE" }), { params: Promise.resolve({ subjectId: "user-1" }) });
    expect(response.status).toBe(expectedStatus);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("mutation-guards malformed non-empty JSON before revocation", async () => {
    const response = await DELETE(new NextRequest("https://login.dev.ctxhost.com/api/admin/enrollments/user-1", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{",
    }), { params: Promise.resolve({ subjectId: "user-1" }) });
    expect(response.status).toBe(400);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("allows an actually empty DELETE body", async () => {
    mockRevoke.mockResolvedValue({ enrollment: { id: "enrollment-1", status: "revoked", version: 2, revokedAt: new Date() }, idempotent: false });
    const response = await DELETE(new NextRequest("https://login.dev.ctxhost.com/api/admin/enrollments/user-1", { method: "DELETE" }), { params: Promise.resolve({ subjectId: "user-1" }) });
    expect(response.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith({ userId: "user-1", reason: undefined });
  });

  it.each(["[]", "\"reason\"", "42", "null"])("mutation-guards non-object JSON %s", async (body) => {
    const response = await DELETE(new NextRequest("https://login.dev.ctxhost.com/api/admin/enrollments/user-1", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body,
    }), { params: Promise.resolve({ subjectId: "user-1" }) });
    expect(response.status).toBe(400);
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
