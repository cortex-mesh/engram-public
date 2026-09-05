import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";

const {
  mockAuthenticateRequest,
  mockCreateMagicLink,
  mockConsumeMagicLink,
  mockGetEmailIdentityForClient,
  mockSendEmail,
} =
  vi.hoisted(() => ({
    mockAuthenticateRequest: vi.fn(),
    mockCreateMagicLink: vi.fn(),
    mockConsumeMagicLink: vi.fn(),
    mockGetEmailIdentityForClient: vi.fn(),
    mockSendEmail: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ authenticateRequest: mockAuthenticateRequest }));
vi.mock("@/lib/db/magic-links", () => ({
  createMagicLink: mockCreateMagicLink,
  consumeMagicLink: mockConsumeMagicLink,
}));
vi.mock("@/lib/email", () => ({
  getEmailIdentityForClient: mockGetEmailIdentityForClient,
  renderSetPasswordEmail: vi.fn((identity, setUrl: string) => ({
    subject: `Set your ${identity.brandName} password`,
    html: `<a href="${setUrl}">Set my password</a>`,
    text: `Set my password: ${setUrl}`,
  })),
  sendEmailBestEffort: mockSendEmail,
}));

import { mockPrisma } from "../../mocks/prisma";
import { _resetRateLimitForTests } from "@/lib/rate-limit";
import { POST as requestPOST } from "@/app/api/auth/set-password/request/route";
import { POST as setPOST } from "@/app/api/auth/set-password/route";
import { buildSetPasswordRequestInit } from "@/app/account/set-password-button";

const BASE = "https://login.dev.ctxhost.com";

function resetPrisma() {
  Object.values(mockPrisma).forEach((model) => {
    if (model && typeof model === "object") {
      Object.values(model).forEach((fn) => (fn as { mockReset?: () => void }).mockReset?.());
    }
  });
}

describe("set-password request", () => {
  function req(headers: Record<string, string> = {}) {
    return new NextRequest(`${BASE}/api/auth/set-password/request`, { method: "POST", headers });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrisma();
    _resetRateLimitForTests();
    process.env.ENGRAM_ALLOWED_ORIGINS = "";
    process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "";
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockGetEmailIdentityForClient.mockImplementation((clientId: string | null) => {
      if (clientId === "tradepost-web") {
        return Promise.resolve({
          clientId: "tradepost-web",
          brandName: "CCG Tradepost",
          fromName: "CCG Tradepost",
          fromAddress: "noreply@ctxhost.com",
          from: "CCG Tradepost <noreply@ctxhost.com>",
          primaryColor: "#d6a84f",
          templateTheme: "tradepost",
          securedByEngram: true,
        });
      }
      return Promise.resolve({
        clientId: null,
        brandName: "CORTEX",
        fromName: "CORTEX",
        fromAddress: "noreply@ctxhost.com",
        from: "CORTEX <noreply@ctxhost.com>",
        primaryColor: "#2563eb",
        templateTheme: "cortex",
        securedByEngram: false,
      });
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "u@example.com" });
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue(null);
    mockCreateMagicLink.mockResolvedValue({ token: "set-tok", expiresAt: new Date() });
    mockPrisma.auditLog.create.mockResolvedValue({});
  });

  it("issues a set_password link and emails it", async () => {
    const res = await requestPOST(req());
    expect(res.status).toBe(200);
    expect(mockCreateMagicLink).toHaveBeenCalledWith("user-1", "set_password");
    expect(mockSendEmail).toHaveBeenCalled();
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.to).toBe("u@example.com");
    expect(sent.from).toBe("CORTEX <noreply@ctxhost.com>");
    expect(sent.subject).toBe("Set your CORTEX password");
    expect(sent.html).toContain("/set-password?token=set-tok");
    expect(sent.text).toContain("/set-password?token=set-tok");
  });

  it("rejects conflicting query and JSON client ids on the Cite host before authenticating or issuing a link", async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
    const res = await requestPOST(new NextRequest(
      "https://auth.citethemove.com/api/auth/set-password/request?redirect_uri=%2Fauthorize%3Fclient_id%3Dtradepost-web",
      {
        method: "POST",
        headers: { "content-type": "application/json", host: "auth.citethemove.com" },
        body: JSON.stringify({ clientId: "axon-web" }),
      },
    ));

    expect(res.status).toBe(400);
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    expect(mockCreateMagicLink).not.toHaveBeenCalled();
  });

  it("brands self-service set-password links from the account page caller", async () => {
    const res = await requestPOST(
      new NextRequest(
        `${BASE}/api/auth/set-password/request`,
        buildSetPasswordRequestInit({ clientId: "tradepost-web" }),
      ),
    );

    expect(res.status).toBe(200);
    expect(mockGetEmailIdentityForClient).toHaveBeenCalledWith("tradepost-web");
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.to).toBe("u@example.com");
    expect(sent.from).toBe("CCG Tradepost <noreply@ctxhost.com>");
    expect(sent.subject).toBe("Set your CCG Tradepost password");
    expect(sent.html).toContain("/set-password?token=set-tok&client_id=tradepost-web");
    expect(sent.text).toContain("/set-password?token=set-tok&client_id=tradepost-web");
  });

  it("issues a set_password link on the allowlisted branded host", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.ccgtradepost.com";

    const res = await requestPOST(
      new NextRequest("https://auth.ccgtradepost.com/api/auth/set-password/request", {
        method: "POST",
        headers: { host: "auth.ccgtradepost.com" },
      }),
    );

    expect(res.status).toBe(200);
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.text).toContain("https://auth.ccgtradepost.com/set-password?token=set-tok");
    expect(sent.text).not.toContain("login.ctxhost.com");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);
    expect((await requestPOST(req())).status).toBe(401);
  });

  it("rejects the internal API key", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });
    expect((await requestPOST(req())).status).toBe(403);
  });

  it("blocks a cross-origin cookie write (CSRF)", async () => {
    const res = await requestPOST(
      req({ origin: "https://attacker.example.com", cookie: "engram-access=x" }),
    );
    expect(res.status).toBe(403);
    expect(mockCreateMagicLink).not.toHaveBeenCalled();
  });

  it("rate-limits after 5 requests from an IP", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await requestPOST(req())).status).toBe(200);
    }
    expect((await requestPOST(req())).status).toBe(429);
  });
});

describe("set-password consume", () => {
  function setReq(body: object, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
    return new NextRequest(`${BASE}/api/auth/set-password`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrisma();
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.auditLog.create.mockResolvedValue({});
  });

  it("consumes a set_password token and sets the password + revokes sessions", async () => {
    mockConsumeMagicLink.mockResolvedValue({ valid: true, userId: "user-1" });

    const res = await setPOST(setReq({ token: "set-tok", newPassword: "newpass12" }));

    expect(res.status).toBe(200);
    expect(mockConsumeMagicLink).toHaveBeenCalledWith("set-tok", "set_password");
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" }, data: expect.objectContaining({ emailVerified: true }) }),
    );
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("rejects a cross-site POST", async () => {
    const res = await setPOST(setReq({ token: "set-tok", newPassword: "newpass12" }, { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(mockConsumeMagicLink).not.toHaveBeenCalled();
  });

  it("rejects a short password before consuming", async () => {
    const res = await setPOST(setReq({ token: "set-tok", newPassword: "short" }));
    expect(res.status).toBe(400);
    expect(mockConsumeMagicLink).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid/expired token", async () => {
    mockConsumeMagicLink.mockResolvedValue({ valid: false, reason: "expired" });
    const res = await setPOST(setReq({ token: "old", newPassword: "newpass12" }));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 400 when the token is missing", async () => {
    const res = await setPOST(setReq({ newPassword: "newpass12" }));
    expect(res.status).toBe(400);
  });
});
