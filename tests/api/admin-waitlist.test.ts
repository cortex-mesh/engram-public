import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateRequest,
  mockCreateMagicLink,
  mockGenerateUniqueUsername,
  mockGetEmailIdentityForClient,
  mockRecordAuditEvent,
  mockRenderApprovalSetPasswordEmail,
  mockSendEmailRequired,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockCreateMagicLink: vi.fn(),
  mockGenerateUniqueUsername: vi.fn(),
  mockGetEmailIdentityForClient: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
  mockRenderApprovalSetPasswordEmail: vi.fn(),
  mockSendEmailRequired: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/db/magic-links", () => ({
  createMagicLink: mockCreateMagicLink,
}));

vi.mock("@/lib/email", () => ({
  getEmailIdentityForClient: mockGetEmailIdentityForClient,
  renderApprovalSetPasswordEmail: mockRenderApprovalSetPasswordEmail,
  sendEmailRequired: mockSendEmailRequired,
}));

vi.mock("@/lib/usernames", () => ({
  generateUniqueUsername: mockGenerateUniqueUsername,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

import { mockPrisma } from "../mocks/prisma";
import { POST as approveWaitlist } from "@/app/api/admin/waitlist/approve/route";
import { PATCH as updateWaitlistVisibility } from "@/app/api/admin/waitlist/[id]/visibility/route";

function makeApprovalRequest(body: Record<string, unknown>) {
  return new NextRequest("https://login.dev.ctxhost.com/api/admin/waitlist/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeVisibilityRequest(body: Record<string, unknown>) {
  return new NextRequest("https://login.dev.ctxhost.com/api/admin/waitlist/waitlist-1/visibility", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function waitlistRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "waitlist-1",
    email: "real@applicant.test",
    displayName: "Real Applicant",
    clientId: "tradepost-web",
    emailHygieneStatus: "accepted",
    emailHygieneReason: null,
    approvedAt: null,
    createdAt: new Date("2026-07-14T12:00:00.000Z"),
    ...overrides,
  };
}

describe("admin waitlist approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
    mockAuthenticateRequest.mockResolvedValue({
      userId: "superadmin-1",
      role: "SUPERADMIN",
    });
    mockGenerateUniqueUsername.mockResolvedValue("real-applicant");
    mockCreateMagicLink.mockResolvedValue({ token: "set-password-token" });
    mockGetEmailIdentityForClient.mockResolvedValue({
      from: "Engram <noreply@ctxhost.com>",
    });
    mockRenderApprovalSetPasswordEmail.mockReturnValue({
      subject: "Your account is ready",
      html: "<p>Ready</p>",
      text: "Ready",
    });
    mockSendEmailRequired.mockResolvedValue({});
    mockRecordAuditEvent.mockResolvedValue({});
  });

  it("requires the exact email recipients before sending approval email", async () => {
    const response = await approveWaitlist(makeApprovalRequest({ ids: ["waitlist-1"] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Approval requires confirming the exact email recipients.",
    });
    expect(mockPrisma.waitlistRequest.findMany).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
  });

  it("rejects approval batches over 50 with an honest cap message", async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `waitlist-${index}`);
    const confirmEmails = ids.map((id) => `${id}@applicant.test`);

    const response = await approveWaitlist(makeApprovalRequest({ ids, confirmEmails }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Approval batches are capped at 50 people. Select fewer rows and try again.",
    });
    expect(mockPrisma.waitlistRequest.findMany).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
  });

  it("rejects stale approval when a selected row is hidden or otherwise unavailable", async () => {
    mockPrisma.waitlistRequest.findMany.mockResolvedValue([]);

    const response = await approveWaitlist(
      makeApprovalRequest({
        ids: ["waitlist-1"],
        confirmEmails: ["real@applicant.test"],
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Approval recipients changed. Refresh the queue and confirm again.",
    });
    expect(mockPrisma.waitlistRequest.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["waitlist-1"] }, approvedAt: null, hiddenAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
  });

  it("rejects approval when confirmed emails do not match the selected rows", async () => {
    mockPrisma.waitlistRequest.findMany.mockResolvedValue([waitlistRow()]);

    const response = await approveWaitlist(
      makeApprovalRequest({
        ids: ["waitlist-1"],
        confirmEmails: ["wrong@applicant.test"],
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Approval recipients do not match the confirmed email list.",
    });
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
  });

  it("approves matching confirmed recipients and emails only those addresses", async () => {
    mockPrisma.waitlistRequest.findMany.mockResolvedValue([waitlistRow()]);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: "user-1",
      email: "real@applicant.test",
    });
    mockPrisma.waitlistRequest.update.mockResolvedValue({});

    const response = await approveWaitlist(
      makeApprovalRequest({
        ids: ["waitlist-1"],
        confirmEmails: ["REAL@applicant.test"],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, approved: 1 });
    expect(mockPrisma.waitlistRequest.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["waitlist-1"] }, approvedAt: null, hiddenAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: {
        email: "real@applicant.test",
        username: "real-applicant",
        displayName: "Real Applicant",
        emailVerified: false,
        role: "USER",
      },
      select: { id: true, email: true },
    });
    expect(mockSendEmailRequired).toHaveBeenCalledWith({
      to: "real@applicant.test",
      from: "Engram <noreply@ctxhost.com>",
      subject: "Your account is ready",
      html: "<p>Ready</p>",
      text: "Ready",
    });
  });
});

describe("admin waitlist visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
    mockAuthenticateRequest.mockResolvedValue({
      userId: "superadmin-1",
      role: "SUPERADMIN",
    });
    mockRecordAuditEvent.mockResolvedValue({});
  });

  it("requires a platform superadmin to hide waitlist rows", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await updateWaitlistVisibility(
      makeVisibilityRequest({ hidden: true }),
      { params: Promise.resolve({ id: "waitlist-1" }) },
    );

    expect(response.status).toBe(403);
    expect(mockPrisma.waitlistRequest.update).not.toHaveBeenCalled();
  });

  it("soft-hides likely test rows without deleting the waitlist request", async () => {
    const hiddenAt = new Date("2026-07-14T18:00:00.000Z");
    mockPrisma.waitlistRequest.findUnique.mockResolvedValue({
      id: "waitlist-1",
      approvedAt: null,
    });
    mockPrisma.waitlistRequest.update.mockResolvedValue({
      id: "waitlist-1",
      email: "test@example.com",
      clientId: "tradepost-web",
      hiddenAt,
    });

    const response = await updateWaitlistVisibility(
      makeVisibilityRequest({ hidden: true, reason: "Marked as test/junk (test@example.com)" }),
      { params: Promise.resolve({ id: "waitlist-1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      hiddenAt: "2026-07-14T18:00:00.000Z",
    });
    expect(mockPrisma.waitlistRequest.update).toHaveBeenCalledWith({
      where: { id: "waitlist-1" },
      data: {
        hiddenAt: expect.any(Date),
        hiddenByUserId: "superadmin-1",
        hiddenReason: "Marked as test/junk (test@example.com)",
      },
      select: { id: true, email: true, clientId: true, hiddenAt: true },
    });
    expect(mockPrisma.waitlistRequest).not.toHaveProperty("deleteMany");
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "waitlist.hide",
      targetType: "waitlist_request",
      targetId: "waitlist-1",
    }));
  });

  it("restores hidden rows by clearing only the soft-hide fields", async () => {
    mockPrisma.waitlistRequest.findUnique.mockResolvedValue({
      id: "waitlist-1",
      approvedAt: null,
    });
    mockPrisma.waitlistRequest.update.mockResolvedValue({
      id: "waitlist-1",
      email: "test@example.com",
      clientId: "tradepost-web",
      hiddenAt: null,
    });

    const response = await updateWaitlistVisibility(
      makeVisibilityRequest({ hidden: false, reason: "Restored to waitlist queue" }),
      { params: Promise.resolve({ id: "waitlist-1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, hiddenAt: null });
    expect(mockPrisma.waitlistRequest.update).toHaveBeenCalledWith({
      where: { id: "waitlist-1" },
      data: {
        hiddenAt: null,
        hiddenByUserId: null,
        hiddenReason: null,
      },
      select: { id: true, email: true, clientId: true, hiddenAt: true },
    });
  });

  it("does not allow approved rows to be soft-hidden", async () => {
    mockPrisma.waitlistRequest.findUnique.mockResolvedValue({
      id: "waitlist-1",
      approvedAt: new Date("2026-07-14T18:00:00.000Z"),
    });

    const response = await updateWaitlistVisibility(
      makeVisibilityRequest({ hidden: true, reason: "Marked as test/junk" }),
      { params: Promise.resolve({ id: "waitlist-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Approved waitlist requests cannot be hidden.",
    });
    expect(mockPrisma.waitlistRequest.update).not.toHaveBeenCalled();
  });

  it("returns not-found only when the waitlist row is actually missing", async () => {
    mockPrisma.waitlistRequest.findUnique.mockResolvedValue(null);

    const response = await updateWaitlistVisibility(
      makeVisibilityRequest({ hidden: true }),
      { params: Promise.resolve({ id: "waitlist-1" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Waitlist request not found." });
    expect(mockPrisma.waitlistRequest.update).not.toHaveBeenCalled();
  });

  it("reports transient visibility write failures as failures, not deletion", async () => {
    mockPrisma.waitlistRequest.findUnique.mockResolvedValue({
      id: "waitlist-1",
      approvedAt: null,
    });
    mockPrisma.waitlistRequest.update.mockRejectedValue(new Error("database timeout"));

    const response = await updateWaitlistVisibility(
      makeVisibilityRequest({ hidden: true }),
      { params: Promise.resolve({ id: "waitlist-1" }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Waitlist visibility update failed." });
  });
});
