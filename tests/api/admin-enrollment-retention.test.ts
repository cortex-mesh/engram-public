import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticate, mockRetire, mockCrossOrigin } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockRetire: vi.fn(),
  mockCrossOrigin: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticate,
  isCurrentPlatformSuperadmin: vi.fn(
    async (auth) => auth?.role === "SUPERADMIN",
  ),
}));
vi.mock("@/lib/enrollment", () => ({
  retireEnrollmentEventsBefore: mockRetire,
  EnrollmentInputError: class EnrollmentInputError extends Error {},
}));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("@/lib/organizations", () => ({
  hasCrossOriginCookieWrite: mockCrossOrigin,
}));

import { POST } from "@/app/api/admin/enrollments/retention/route";

describe("POST /api/admin/enrollments/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      userId: "admin-1",
      role: "SUPERADMIN",
    });
    mockCrossOrigin.mockReturnValue(false);
  });

  it.each([
    ["unauthenticated", undefined, false, 401],
    ["user", { userId: "user-1", role: "USER" }, false, 403],
    ["admin", { userId: "admin-1", role: "ADMIN" }, false, 403],
    ["internal", { userId: "internal", role: "ADMIN" }, false, 403],
    [
      "cross-origin cookie write",
      { userId: "admin-1", role: "SUPERADMIN" },
      true,
      403,
    ],
  ])(
    "denies %s before advancing retention",
    async (_name, auth, crossOrigin, expectedStatus) => {
      mockAuthenticate.mockResolvedValue(auth);
      mockCrossOrigin.mockReturnValue(crossOrigin);
      const response = await POST(
        new NextRequest(
          "https://login.dev.ctxhost.com/api/admin/enrollments/retention",
          {
            method: "POST",
            body: JSON.stringify({ firstRetainedSequence: 2 }),
          },
        ),
      );
      expect(response.status).toBe(expectedStatus);
      expect(mockRetire).not.toHaveBeenCalled();
    },
  );

  it("invokes the audited operational retention lifecycle", async () => {
    mockRetire.mockResolvedValue({ retainedFrom: 2, headSequence: 2 });
    const response = await POST(
      new NextRequest(
        "https://login.dev.ctxhost.com/api/admin/enrollments/retention",
        {
          method: "POST",
          body: JSON.stringify({ firstRetainedSequence: 2 }),
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(mockRetire).toHaveBeenCalledWith(2);
  });

  it.each([0, -1])(
    "rejects non-positive floor %s before mutation",
    async (firstRetainedSequence) => {
      const response = await POST(
        new NextRequest(
          "https://login.dev.ctxhost.com/api/admin/enrollments/retention",
          {
            method: "POST",
            body: JSON.stringify({ firstRetainedSequence }),
          },
        ),
      );
      expect(response.status).toBe(400);
      expect(mockRetire).not.toHaveBeenCalled();
    },
  );

  it.each(["null", "[]", '"retire"', "42", "{"])(
    "rejects malformed retention body %s",
    async (body) => {
      const response = await POST(
        new NextRequest(
          "https://login.dev.ctxhost.com/api/admin/enrollments/retention",
          { method: "POST", body },
        ),
      );
      expect(response.status).toBe(400);
      expect(mockRetire).not.toHaveBeenCalled();
    },
  );
});
