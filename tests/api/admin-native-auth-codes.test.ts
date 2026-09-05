import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

import { mockPrisma } from "../mocks/prisma";
import { POST } from "@/app/api/admin/native-auth-codes/route";

const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("https://login.dev.ctxhost.com/api/admin/native-auth-codes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "synapse-native",
    redirectUri: "synapse://auth/engram/callback",
    tenant: "cortex",
    app: "synapse",
    userEmail: "demo.member@ctxhost.local",
    codeChallenge: CODE_CHALLENGE,
    state: "state-123",
    ...overrides,
  };
}

function mockRegisteredClient() {
  mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
    clientId: "synapse-native",
    displayName: "Synapse Native",
    enabled: true,
    redirectUris: [{ redirectUri: "synapse://auth/engram/callback", enabled: true }],
  });
}

function mockAdmittedUser() {
  mockPrisma.user.findUnique.mockResolvedValue({
    id: "user-1",
    email: "demo.member@ctxhost.local",
  });
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: "org-1",
    members: [{ id: "member-1" }],
    appEntitlements: [{ enabled: true }],
    userAppOverrides: [],
  });
}

describe("POST /api/admin/native-auth-codes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE = "1";
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
    mockAuthenticateRequest.mockResolvedValue({
      userId: "superadmin-1",
      role: "SUPERADMIN",
    });
    mockRegisteredClient();
    mockAdmittedUser();
    mockPrisma.nativeAuthAuthorizationCode.create.mockResolvedValue({});
  });

  it("is unavailable unless explicitly enabled", async () => {
    delete process.env.ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE;

    const response = await POST(makeRequest(validBody()));

    expect(response.status).toBe(404);
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("requires a platform superadmin", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await POST(makeRequest(validBody()));

    expect(response.status).toBe(403);
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("does not allow internal API key auth to issue native fixture codes", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "internal", role: "ADMIN" });

    const response = await POST(makeRequest(validBody()));

    expect(response.status).toBe(403);
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("issues a real short-lived auth code for an existing admitted user", async () => {
    const response = await POST(makeRequest(validBody()));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      clientId: "synapse-native",
      redirectUri: "synapse://auth/engram/callback",
      tenant: "cortex",
      app: "synapse",
      userId: "user-1",
      expiresIn: 300,
    });
    expect(body.callbackUrl).toContain("synapse://auth/engram/callback?code=");
    expect(body.callbackUrl).toContain("state=state-123");
    expect(body.callbackUrl).not.toContain(CODE_CHALLENGE);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.nativeAuthAuthorizationCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: "synapse-native",
        userId: "user-1",
        redirectUri: "synapse://auth/engram/callback",
        codeChallenge: CODE_CHALLENGE,
      }),
    });
  });

  it("does not create a user when the requested fixture user is missing", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const response = await POST(makeRequest(validBody()));

    expect(response.status).toBe(404);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("refuses to issue a code when existing user lacks tenant admission", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: "org-1",
      members: [],
      appEntitlements: [{ enabled: true }],
      userAppOverrides: [],
    });

    const response = await POST(makeRequest(validBody()));

    expect(response.status).toBe(403);
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });
});
