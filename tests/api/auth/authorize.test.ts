import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
}));

import { mockPrisma } from "../../mocks/prisma";
import { GET } from "@/app/authorize/route";

const AUTH_URL =
  "https://login.dev.ctxhost.com/authorize?response_type=code&client_id=synapse-native&redirect_uri=synapse%3A%2F%2Fauth%2Fengram%2Fcallback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=state-123&tenant=cortex&app=synapse";

function makeRequest(
  url = AUTH_URL,
  options: { cookie?: string; headers?: Record<string, string> } = {},
) {
  return new NextRequest(
    new Request(url, {
      headers: {
        ...options.headers,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    }),
  );
}

function mockRegisteredSynapseNativeClient(redirectUri = "synapse://auth/engram/callback") {
  mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
    clientId: "synapse-native",
    displayName: "Synapse Native",
    enabled: true,
    redirectUris: [{ redirectUri, enabled: true }],
  });
}

function mockNativeAdmission(overrides: {
  members?: Array<{ id: string }>;
  appEntitlements?: Array<{ enabled: boolean }>;
  userAppOverrides?: Array<{ enabled: boolean }>;
} = {}) {
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: "org-cortex",
    members: overrides.members ?? [{ id: "member-1" }],
    appEntitlements: overrides.appEntitlements ?? [{ enabled: true }],
    userAppOverrides: overrides.userAppOverrides ?? [],
  });
}

describe("GET /authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ENGRAM_URL;
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
    mockRegisteredSynapseNativeClient();
  });

  it("validates the registered client before redirecting to login", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://login.dev.ctxhost.com");
    expect(location.pathname).toBe("/api/auth/continue");
    const redirectUri = location.searchParams.get("redirect_uri");
    expect(redirectUri).toContain("client_id=synapse-native");
    expect(redirectUri).toContain("tenant=cortex");
    expect(redirectUri).toContain("app=synapse");
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a non-Axon client on the exact Cite auth host before registration lookup", async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
    const response = await GET(makeRequest(AUTH_URL, { headers: { host: "auth.citethemove.com" } }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(mockPrisma.nativeAuthClient.findUnique).not.toHaveBeenCalled();
  });

  it("allows tenantless native authorization to start from the login environment", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);

    const response = await GET(makeRequest(AUTH_URL.replace("&tenant=cortex", "")));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://login.dev.ctxhost.com");
    expect(location.pathname).toBe("/api/auth/continue");
    const redirectUri = location.searchParams.get("redirect_uri");
    expect(redirectUri).toContain("client_id=synapse-native");
    expect(redirectUri).not.toContain("tenant=");
    expect(redirectUri).toContain("app=synapse");
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it("uses ENGRAM_URL for continue redirects behind a reverse proxy", async () => {
    process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";
    mockAuthenticateRequest.mockResolvedValue(null);

    const response = await GET(
      makeRequest(AUTH_URL.replace("https://login.dev.ctxhost.com", "http://0.0.0.0:3104")),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "https://login.dev.ctxhost.com/api/auth/continue?",
    );
    expect(response.headers.get("location")).not.toContain("0.0.0.0");
  });

  it("honors prompt=login by forcing the continue login path without issuing a code", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });

    const response = await GET(
      makeRequest(`${AUTH_URL}&prompt=login`, { cookie: "engram-access=access-token" }),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://login.dev.ctxhost.com");
    expect(location.pathname).toBe("/api/auth/continue");
    expect(location.searchParams.get("prompt")).toBe("login");
    expect(location.searchParams.get("redirect_uri")).toContain("client_id=synapse-native");
    expect(location.searchParams.get("redirect_uri")).toContain("tenant=cortex");
    expect(location.searchParams.get("redirect_uri")).toContain("app=synapse");
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("issues a single-use authorization code and shows a native completion page", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockNativeAdmission();
    mockPrisma.nativeAuthAuthorizationCode.create.mockResolvedValue({});

    const response = await GET(makeRequest(AUTH_URL, { cookie: "engram-access=access-token" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("Engram sign-in complete");
    expect(body).toContain("Synapse Native should open automatically");
    expect(body).toContain("Open Synapse Native");
    expect(body).toContain("synapse://auth/engram/callback?code=");
    expect(body).toContain("state=state-123");
    expect(mockPrisma.organization.findUnique).toHaveBeenCalledWith({
      where: { slug: "cortex" },
      select: {
        id: true,
        members: {
          where: { userId: "user-1" },
          select: { id: true },
        },
        appEntitlements: {
          where: { appKey: "synapse" },
          select: { enabled: true },
        },
        userAppOverrides: {
          where: { userId: "user-1", appKey: "synapse" },
          select: { enabled: true },
        },
      },
    });
    expect(mockPrisma.nativeAuthAuthorizationCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: "synapse-native",
        userId: "user-1",
        redirectUri: "synapse://auth/engram/callback",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      }),
    });
  });

  it("keeps browser-handled redirect URIs as server redirects", async () => {
    const redirectUri = "https://native.example.com/callback";
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockNativeAdmission();
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "synapse-native",
      displayName: "Synapse Native",
      enabled: true,
      redirectUris: [{ redirectUri, enabled: true }],
    });
    mockPrisma.nativeAuthAuthorizationCode.create.mockResolvedValue({});

    const response = await GET(
      makeRequest(
        AUTH_URL.replace(
          "redirect_uri=synapse%3A%2F%2Fauth%2Fengram%2Fcallback",
          `redirect_uri=${encodeURIComponent(redirectUri)}`,
        ),
        { cookie: "engram-access=access-token" },
      ),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("https://native.example.com/callback?code=");
    expect(location).toContain("state=state-123");
  });

  it("rejects unregistered redirect URIs", async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "synapse-native",
      displayName: "Synapse Native",
      enabled: true,
      redirectUris: [{ redirectUri: "synapse://auth/engram/callback", enabled: true }],
    });

    const response = await GET(
      makeRequest(
        AUTH_URL.replace(
          "redirect_uri=synapse%3A%2F%2Fauth%2Fengram%2Fcallback",
          "redirect_uri=evil%3A%2F%2Fauth%2Fcallback",
        ),
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_client",
    });
  });

  it("issues a tenantless authorization code without preselecting an org", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockPrisma.nativeAuthAuthorizationCode.create.mockResolvedValue({});

    const response = await GET(
      makeRequest(AUTH_URL.replace("&tenant=cortex", ""), {
        cookie: "engram-access=access-token",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Engram sign-in complete");
    expect(body).toContain("synapse://auth/engram/callback?code=");
    expect(body).toContain("state=state-123");
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.nativeAuthAuthorizationCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: "synapse-native",
        userId: "user-1",
        redirectUri: "synapse://auth/engram/callback",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      }),
    });
  });

  it("requires app context before starting native authorization", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);

    const response = await GET(
      makeRequest(AUTH_URL.replace("&tenant=cortex&app=synapse", "")),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_request",
    });
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("fails closed without issuing a code when the user is not a tenant member", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockNativeAdmission({ members: [] });

    const response = await GET(makeRequest(AUTH_URL, { cookie: "engram-access=access-token" }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Engram sign-in could not continue");
    expect(body).toContain("error=access_denied");
    expect(body).toContain("state=state-123");
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("fails closed without issuing a code when the org lacks the requested app", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockNativeAdmission({ appEntitlements: [] });

    const response = await GET(makeRequest(AUTH_URL, { cookie: "engram-access=access-token" }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("error=access_denied");
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("fails closed without issuing a code when a per-user app deny exists", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-1", role: "USER" });
    mockNativeAdmission({ userAppOverrides: [{ enabled: false }] });

    const response = await GET(makeRequest(AUTH_URL, { cookie: "engram-access=access-token" }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("error=access_denied");
    expect(mockPrisma.nativeAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });
});
