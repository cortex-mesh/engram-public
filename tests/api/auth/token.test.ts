import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

process.env.ENGRAM_JWT_SECRET = "test-secret-for-native-token-route";

import { mockPrisma } from "../../mocks/prisma";
import { sha256 } from "@/lib/crypto";
import { _resetRateLimitForTests } from "@/lib/rate-limit";
import { POST } from "@/app/api/auth/token/route";

const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function makeFormRequest(
  body: Record<string, string>,
  options: { url?: string; headers?: Record<string, string> } = {},
) {
  return new NextRequest(options.url || "https://login.dev.ctxhost.com/api/auth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...options.headers,
    },
    body: new URLSearchParams(body).toString(),
  });
}

function makeJsonRequest(body: Record<string, string>) {
  return new NextRequest("https://login.dev.ctxhost.com/api/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/token", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    delete process.env.ENGRAM_URL;
    delete process.env.ENGRAM_ALLOWED_HOSTS;
    process.env.ENGRAM_AXON_ENROLLMENT_API_KEY = "";
    process.env.ENGRAM_ENROLLMENT_SIGNING_KEY_ID = "";
    process.env.ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY = "";
    process.env.ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY = "";
    process.env.ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE = "";
    process.env.ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER = "";
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "broca-macos-dev",
      displayName: "Broca Dev",
      enabled: true,
      redirectUris: [{ redirectUri: "broca://auth/callback", enabled: true }],
    });
  });

  it("exchanges a valid authorization code and PKCE verifier for tokens while Cite enrollment variables are explicitly empty", async () => {
    mockPrisma.nativeAuthAuthorizationCode.findFirst.mockResolvedValue({
      id: "code-1",
      codeHash: sha256("auth-code"),
      clientId: "broca-macos-dev",
      userId: "user-1",
      redirectUri: "broca://auth/callback",
      codeChallenge: CODE_CHALLENGE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.nativeAuthAuthorizationCode.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER" });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const response = await POST(
      makeFormRequest({
        grant_type: "authorization_code",
        code: "auth-code",
        client_id: "broca-macos-dev",
        redirect_uri: "broca://auth/callback",
        code_verifier: CODE_VERIFIER,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.tokenType).toBe("Bearer");
    expect(body.expiresIn).toBe(900);
    expect(body.tenants).toEqual([]);
    expect(mockPrisma.nativeAuthAuthorizationCode.updateMany).toHaveBeenCalledWith({
      where: { id: "code-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(mockPrisma.refreshToken.create).toHaveBeenCalled();
    expect(mockPrisma.orgMember.findMany).not.toHaveBeenCalled();
  });

  it("rejects a non-Axon token exchange on the Cite auth host before client lookup", async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
    const response = await POST(makeFormRequest(
      {
        grant_type: "authorization_code",
        code: "auth-code",
        client_id: "synapse-native",
        redirect_uri: "synapse://auth/engram/callback",
        code_verifier: CODE_VERIFIER,
      },
      { headers: { host: "auth.citethemove.com" } },
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(mockPrisma.nativeAuthClient.findUnique).not.toHaveBeenCalled();
  });

  it("rejects conflicting direct and redirect-uri client ids on the Cite host before consuming a code", async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
    const response = await POST(makeFormRequest(
      {
        grant_type: "authorization_code",
        code: "auth-code",
        client_id: "axon-web",
        redirect_uri: "axon://auth/callback?client_id=tradepost-web",
        code_verifier: CODE_VERIFIER,
      },
      { headers: { host: "auth.citethemove.com" } },
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(mockPrisma.nativeAuthAuthorizationCode.updateMany).not.toHaveBeenCalled();
  });

  it("returns approved Synapse tenant hosts for the native Synapse client", async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "synapse-native",
      displayName: "Synapse Native",
      enabled: true,
      redirectUris: [{ redirectUri: "synapse://auth/engram/callback", enabled: true }],
    });
    mockPrisma.nativeAuthAuthorizationCode.findFirst.mockResolvedValue({
      id: "code-1",
      codeHash: sha256("auth-code"),
      clientId: "synapse-native",
      userId: "user-1",
      redirectUri: "synapse://auth/engram/callback",
      codeChallenge: CODE_CHALLENGE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.nativeAuthAuthorizationCode.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER" });
    mockPrisma.orgMember.findMany.mockResolvedValue([
      {
        org: {
          id: "org-cortex",
          slug: "cortex",
          name: "CORTEX",
        },
      },
      {
        org: {
          id: "org-demo",
          slug: "demo",
          name: "Demo",
        },
      },
    ]);
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const response = await POST(
      makeFormRequest({
        grant_type: "authorization_code",
        code: "auth-code",
        client_id: "synapse-native",
        redirect_uri: "synapse://auth/engram/callback",
        code_verifier: CODE_VERIFIER,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenants).toEqual([
      {
        orgId: "org-cortex",
        slug: "cortex",
        displayName: "CORTEX",
        tenantHost: "cortex.dev.ctxhost.com",
      },
      {
        orgId: "org-demo",
        slug: "demo",
        displayName: "Demo",
        tenantHost: "demo.dev.ctxhost.com",
      },
    ]);
    expect(mockPrisma.orgMember.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        org: {
          is: {
            appEntitlements: {
              some: { appKey: "synapse", enabled: true },
            },
            userAppOverrides: {
              none: { userId: "user-1", appKey: "synapse", enabled: false },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
      include: {
        org: { select: { id: true, slug: true, name: true } },
      },
    });
  });

  it("uses the configured canonical authority, not a forwarded request origin, for returned native tenant hosts", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.dev.ctxhost.com";
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "synapse-native",
      displayName: "Synapse Native",
      enabled: true,
      redirectUris: [{ redirectUri: "synapse://auth/engram/callback", enabled: true }],
    });
    mockPrisma.nativeAuthAuthorizationCode.findFirst.mockResolvedValue({
      id: "code-1",
      codeHash: sha256("auth-code"),
      clientId: "synapse-native",
      userId: "user-1",
      redirectUri: "synapse://auth/engram/callback",
      codeChallenge: CODE_CHALLENGE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.nativeAuthAuthorizationCode.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER" });
    mockPrisma.orgMember.findMany.mockResolvedValue([
      {
        org: {
          id: "org-cortex",
          slug: "cortex",
          name: "CORTEX",
        },
      },
    ]);
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const response = await POST(
      makeFormRequest(
        {
          grant_type: "authorization_code",
          code: "auth-code",
          client_id: "synapse-native",
          redirect_uri: "synapse://auth/engram/callback",
          code_verifier: CODE_VERIFIER,
        },
        {
          url: "http://0.0.0.0:3104/api/auth/token",
          headers: {
            "x-forwarded-host": "login.dev.ctxhost.com",
            "x-forwarded-proto": "https",
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenants).toEqual([
      {
        orgId: "org-cortex",
        slug: "cortex",
        displayName: "CORTEX",
        tenantHost: "cortex.ctxhost.com",
      },
    ]);
  });

  it("never emits a Cite auth alias as an Axon tenant host", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com";
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "axon-web",
      displayName: "Cite the Move",
      enabled: true,
      redirectUris: [{ redirectUri: "https://app.citethemove.com/auth/callback", enabled: true }],
    });
    mockPrisma.nativeAuthAuthorizationCode.findFirst.mockResolvedValue({
      id: "code-axon",
      codeHash: sha256("auth-code"),
      clientId: "axon-web",
      userId: "user-1",
      redirectUri: "https://app.citethemove.com/auth/callback",
      codeChallenge: CODE_CHALLENGE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.nativeAuthAuthorizationCode.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER" });
    mockPrisma.orgMember.findMany.mockResolvedValue([
      { org: { id: "org-cortex", slug: "cortex", name: "CORTEX" } },
    ]);
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const response = await POST(makeFormRequest(
      {
        grant_type: "authorization_code",
        code: "auth-code",
        client_id: "axon-web",
        redirect_uri: "https://app.citethemove.com/auth/callback",
        code_verifier: CODE_VERIFIER,
      },
      {
        url: "https://auth.citethemove.com/api/auth/token",
        headers: { host: "auth.citethemove.com" },
      },
    ));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenants).toEqual([
      expect.objectContaining({ tenantHost: "cortex.ctxhost.com" }),
    ]);
    expect(body.tenants[0].tenantHost).not.toContain("auth.citethemove.com");
  });

  it("rejects an invalid PKCE verifier", async () => {
    mockPrisma.nativeAuthAuthorizationCode.findFirst.mockResolvedValue({
      id: "code-1",
      codeHash: sha256("auth-code"),
      clientId: "broca-macos-dev",
      userId: "user-1",
      redirectUri: "broca://auth/callback",
      codeChallenge: CODE_CHALLENGE,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await POST(
      makeJsonRequest({
        grant_type: "authorization_code",
        code: "auth-code",
        client_id: "broca-macos-dev",
        redirect_uri: "broca://auth/callback",
        code_verifier: `${CODE_VERIFIER}x`,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("rejects unregistered native clients", async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue(null);

    const response = await POST(
      makeJsonRequest({
        grant_type: "authorization_code",
        code: "auth-code",
        client_id: "broca-macos-dev",
        redirect_uri: "broca://auth/callback",
        code_verifier: CODE_VERIFIER,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_client",
    });
  });

  it("returns an OAuth-shaped slow_down error when rate limited", async () => {
    // 10 cheap invalid requests consume the per-IP budget
    for (let i = 0; i < 10; i++) {
      await POST(makeJsonRequest({ grant_type: "bogus" }));
    }

    const blocked = await POST(makeJsonRequest({ grant_type: "bogus" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "slow_down",
      error_description: expect.stringContaining("Too many"),
    });
  });
});
