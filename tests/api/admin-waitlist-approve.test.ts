import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";

const {
  mockAuthenticateRequest,
  mockIsCurrentPlatformSuperadmin,
  mockCreateMagicLink,
  mockGetEmailIdentityForClient,
  mockRenderApprovalSetPasswordEmail,
  mockSendEmailRequired,
  mockHasCrossOriginCookieWrite,
  mockRecordAuditEvent,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsCurrentPlatformSuperadmin: vi.fn(),
  mockCreateMagicLink: vi.fn(),
  mockGetEmailIdentityForClient: vi.fn(),
  mockRenderApprovalSetPasswordEmail: vi.fn(),
  mockSendEmailRequired: vi.fn(),
  mockHasCrossOriginCookieWrite: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: mockIsCurrentPlatformSuperadmin,
}));
vi.mock("@/lib/db/magic-links", () => ({
  createMagicLink: mockCreateMagicLink,
}));
vi.mock("@/lib/email", () => ({
  getEmailIdentityForClient: mockGetEmailIdentityForClient,
  renderApprovalSetPasswordEmail: mockRenderApprovalSetPasswordEmail,
  sendEmailRequired: mockSendEmailRequired,
}));
vi.mock("@/lib/organizations", () => ({
  hasCrossOriginCookieWrite: mockHasCrossOriginCookieWrite,
  isUniqueConstraintError: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/usernames", () => ({
  generateUniqueUsername: vi.fn().mockResolvedValue("invitee"),
}));
vi.mock("@/lib/audit", () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

import { mockPrisma } from "../mocks/prisma";
import { POST } from "@/app/api/admin/waitlist/approve/route";

function resetPrisma() {
  Object.values(mockPrisma).forEach((model) => {
    if (model && typeof model === "object") {
      Object.values(model).forEach((fn) => (fn as { mockReset?: () => void }).mockReset?.());
    }
  });
}

describe("POST /api/admin/waitlist/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrisma();
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.ENGRAM_ALLOWED_HOSTS = "";
    process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";
    mockAuthenticateRequest.mockResolvedValue({ userId: "admin-1", role: "SUPERADMIN" });
    mockIsCurrentPlatformSuperadmin.mockResolvedValue(true);
    mockHasCrossOriginCookieWrite.mockReturnValue(false);
    mockCreateMagicLink.mockResolvedValue({ token: "set-token", expiresAt: new Date() });
    mockGetEmailIdentityForClient.mockImplementation((clientId: string | null) => {
      if (clientId === "tradepost-web") {
        return Promise.resolve({
          clientId: "tradepost-web",
          brandName: "CCG Tradepost",
          from: "CCG Tradepost <noreply@ctxhost.com>",
        });
      }
      return Promise.resolve({
        clientId: null,
        brandName: "CORTEX",
        from: "CORTEX <noreply@ctxhost.com>",
      });
    });
    mockRenderApprovalSetPasswordEmail.mockImplementation((identity, setUrl) => ({
      subject: `You're in to ${identity.brandName}`,
      html: `<a href="${setUrl}">html</a>`,
      text: `text ${setUrl}`,
    }));
    mockSendEmailRequired.mockResolvedValue(undefined);
    mockRecordAuditEvent.mockResolvedValue(undefined);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: "user-1", email: "invitee@example.com" });
    mockPrisma.waitlistRequest.update.mockResolvedValue({});
    mockPrisma.emailSuppression.findUnique.mockResolvedValue(null);
  });

  it("adds the waitlist client_id to approval set-password links", async () => {
    mockPrisma.waitlistRequest.findMany.mockResolvedValue([
      {
        id: "wait-1",
        email: "invitee@example.com",
        displayName: null,
        clientId: "tradepost-web",
        emailHygieneStatus: "accepted",
        emailHygieneReason: null,
      },
    ]);

    const response = await POST(
      new NextRequest("https://login.dev.ctxhost.com/api/admin/waitlist/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: ["wait-1"],
          confirmEmails: ["invitee@example.com"],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRenderApprovalSetPasswordEmail).toHaveBeenCalledWith(
      expect.anything(),
      "https://login.dev.ctxhost.com/set-password?token=set-token&client_id=tradepost-web",
    );
    expect(mockGetEmailIdentityForClient).toHaveBeenCalledWith("tradepost-web");
    expect(mockSendEmailRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "CCG Tradepost <noreply@ctxhost.com>",
        subject: "You're in to CCG Tradepost",
      }),
    );
  });

  it("keeps legacy approval set-password links clientless when no clientId is stored", async () => {
    mockPrisma.waitlistRequest.findMany.mockResolvedValue([
      {
        id: "wait-1",
        email: "invitee@example.com",
        displayName: null,
        clientId: null,
        emailHygieneStatus: "accepted",
        emailHygieneReason: null,
      },
    ]);

    const response = await POST(
      new NextRequest("https://login.dev.ctxhost.com/api/admin/waitlist/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: ["wait-1"],
          confirmEmails: ["invitee@example.com"],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRenderApprovalSetPasswordEmail).toHaveBeenCalledWith(
      expect.anything(),
      "https://login.dev.ctxhost.com/set-password?token=set-token",
    );
    expect(mockGetEmailIdentityForClient).toHaveBeenCalledWith(null);
    expect(mockSendEmailRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "CORTEX <noreply@ctxhost.com>",
        subject: "You're in to CORTEX",
      }),
    );
  });

  it("blocks approval for a suppressed waitlist address before creating a user", async () => {
    mockPrisma.waitlistRequest.findMany.mockResolvedValue([
      {
        id: "wait-1",
        email: "invitee@example.com",
        displayName: null,
        clientId: "tradepost-web",
        emailHygieneStatus: "accepted",
        emailHygieneReason: null,
      },
    ]);
    mockPrisma.emailSuppression.findUnique.mockResolvedValue({
      email: "invitee@example.com",
      reason: "bounced",
      source: "resend_webhook",
      eventType: "email.bounced",
      providerMessageId: "email-1",
      updatedAt: new Date(),
    });

    const response = await POST(
      new NextRequest("https://login.dev.ctxhost.com/api/admin/waitlist/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: ["wait-1"],
          confirmEmails: ["invitee@example.com"],
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistRequest.update).toHaveBeenCalledWith({
      where: { id: "wait-1" },
      data: expect.objectContaining({
        emailHygieneStatus: "suppressed",
        emailHygieneReason: "bounced via email.bounced",
        confirmationEmailSuppressedAt: expect.any(Date),
      }),
    });
  });
});
