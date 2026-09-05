import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENGRAM_JWT_SECRET = "test-s...ough";
process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";

const { mockJwtVerify } = vi.hoisted(() => ({
  mockJwtVerify: vi.fn(),
}));

vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    jwtVerify: mockJwtVerify,
  };
});

import { mockPrisma } from "../../mocks/prisma";
import { generateTokenPair } from "@/lib/jwt";
import { _resetRateLimitForTests } from "@/lib/rate-limit";
import { GET } from "@/app/api/auth/continue/route";

function makeRequest(url: string, cookie?: string, headers: Record<string, string> = {}) {
  return new NextRequest(
    new Request(url, {
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
    }),
  );
}

describe("GET /api/auth/continue", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    vi.clearAllMocks();
    mockJwtVerify.mockReset();
    process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "";
    delete process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING;
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
  });

  it("redirects straight through when a valid access token is already present", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "access" },
    });

    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fhealth",
        "engram-access=valid-access",
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://plexus.dev.ctxhost.com/health",
    );
    expect(mockPrisma.refreshToken.findFirst).not.toHaveBeenCalled();
  });

  it("rejects conflicting direct and nested client ids on the Cite host before inspecting a session", async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
    const res = await GET(makeRequest(
      "https://auth.citethemove.com/api/auth/continue?client_id=axon-web&redirect_uri=%2Fauthorize%3Fclient_id%3Dtradepost-web",
      "engram-access=valid-access",
      { host: "auth.citethemove.com" },
    ));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=invalid_client");
    expect(mockJwtVerify).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  // This is the incident regression: the production-wide landing URL is
  // Tradepost, but a bare Cite auth request must stay within Cite's own auth
  // host until its external application exists.
  it("keeps a bare Cite continuation on its same-origin account/login flow", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com,auth.ccgtradepost.com";
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = "https://ccgtradepost.com";

    const res = await GET(makeRequest(
      "https://auth.citethemove.com/api/auth/continue",
      undefined,
      { host: "auth.citethemove.com" },
    ));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://auth.citethemove.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect_uri")).toBe("/account?client_id=axon-web");
    expect(location.searchParams.get("client_id")).toBe("axon-web");
    expect(location.searchParams.get("redirect_uri")).not.toContain("ccgtradepost.com");
  });

  it("keeps an existing Cite session on account instead of its org-member default target", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com";
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "access" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      role: "USER",
      orgMembers: [{ org: { id: "org-1", slug: "cortex" } }],
    });

    const res = await GET(makeRequest(
      "https://auth.citethemove.com/api/auth/continue",
      "engram-access=valid-access",
      { host: "auth.citethemove.com" },
    ));

    expect(res.headers.get("location")).toBe("https://auth.citethemove.com/account?client_id=axon-web");
  });

  it("preserves an explicit registered Cite callback instead of replacing it with the fallback", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com,auth.ccgtradepost.com";
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = "https://ccgtradepost.com";
    const callback = "https://app.citethemove.com/auth/callback";
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      enabled: true,
      redirectUris: [{ id: "cite-callback" }],
    });

    const res = await GET(makeRequest(
      `https://auth.citethemove.com/api/auth/continue?redirect_uri=${encodeURIComponent(callback)}`,
      undefined,
      { host: "auth.citethemove.com" },
    ));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://auth.citethemove.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect_uri")).toBe(callback);
    expect(location.searchParams.get("redirect_uri")).not.toContain("ccgtradepost.com");
  });

  it("sends an existing Cite session to its explicit registered callback", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com,auth.ccgtradepost.com";
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = "https://ccgtradepost.com";
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "access" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      role: "USER",
      orgMembers: [],
    });
    const callback = "https://app.citethemove.com/auth/callback";
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      enabled: true,
      redirectUris: [{ id: "cite-callback" }],
    });

    const res = await GET(makeRequest(
      `https://auth.citethemove.com/api/auth/continue?redirect_uri=${encodeURIComponent(callback)}`,
      "engram-access=valid-access",
      { host: "auth.citethemove.com" },
    ));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(callback);
  });

  it.each([
    ["missing Cite client", null],
    ["disabled Cite client", { enabled: false, redirectUris: [{ id: "cite-callback" }] }],
    ["disabled Cite callback", { enabled: true, redirectUris: [] }],
  ])("does not send an existing Cite session to a %s", async (_label, client) => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com";
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "access" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER", orgMembers: [] });
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue(client);

    const res = await GET(makeRequest(
      `https://auth.citethemove.com/api/auth/continue?redirect_uri=${encodeURIComponent("https://app.citethemove.com/auth/callback")}`,
      "engram-access=valid-access",
      { host: "auth.citethemove.com" },
    ));

    expect(res.headers.get("location")).toBe("https://auth.citethemove.com/account?client_id=axon-web");
  });

  it("rejects the globally allowed Tradepost target for an existing Cite session", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com";
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = "https://ccgtradepost.com";
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "access" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER", orgMembers: [] });

    const res = await GET(makeRequest(
      "https://auth.citethemove.com/api/auth/continue?redirect_uri=https%3A%2F%2Fccgtradepost.com%2Faccount",
      "engram-access=valid-access",
      { host: "auth.citethemove.com" },
    ));

    expect(res.headers.get("location")).toBe("https://auth.citethemove.com/account?client_id=axon-web");
  });

  it("redirects to login without resuming cookies when prompt=login is requested", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "access" },
    });

    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?prompt=login&redirect_uri=%2Fauthorize%3Fresponse_type%3Dcode%26client_id%3Dbroca-macos-dev",
        "engram-access=valid-access",
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://login.dev.ctxhost.com/login?redirect_uri=%2Fauthorize%3Fresponse_type%3Dcode%26client_id%3Dbroca-macos-dev&rt=L2F1dGhvcml6ZT9yZXNwb25zZV90eXBlPWNvZGUmY2xpZW50X2lkPWJyb2NhLW1hY29zLWRldg&client_id=broca-macos-dev",
    );
    expect(mockJwtVerify).not.toHaveBeenCalled();
    expect(mockPrisma.refreshToken.findFirst).not.toHaveBeenCalled();
  });

  it("redirects single-org users to their Nexus tenant host when no redirect_uri is provided", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "access" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      role: "USER",
      orgMembers: [{ org: { slug: "cortex" } }],
    });

    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue",
        "engram-access=valid-access",
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://cortex.dev.ctxhost.com/");
  });

  it("preserves client context on the access-token account fallback", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "access" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      role: "USER",
      orgMembers: [],
    });

    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?client_id=tradepost-web",
        "engram-access=valid-access",
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://login.dev.ctxhost.com/account?client_id=tradepost-web",
    );
  });

  it("rotates refresh and redirects back to the requested app when only refresh is valid", async () => {
    const { refreshToken } = await generateTokenPair({
      id: "user-1",
      role: "USER",
    });
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "refresh" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      role: "USER",
      email: "user@example.com",
    });
    // Atomic rotation: consume the presented token (count 1) + create.
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.refreshToken.create.mockResolvedValue({});
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fhealth",
        `engram-refresh=${refreshToken}`,
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://plexus.dev.ctxhost.com/health",
    );
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c: string) => c.includes("engram-access="))).toBe(
      true,
    );
    expect(cookies.some((c: string) => c.includes("engram-refresh="))).toBe(
      true,
    );
  });

  it("uses an active later refresh cookie when a stale duplicate appears first", async () => {
    const stale = await generateTokenPair({ id: "user-1", role: "USER" });
    const fresh = await generateTokenPair({ id: "user-1", role: "USER" });
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "refresh" },
    });
    mockPrisma.refreshToken.findUnique
      .mockResolvedValueOnce({
        consumedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      role: "USER",
      orgMembers: [],
    });
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.refreshToken.create.mockResolvedValue({});
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fhealth",
        `engram-refresh=${stale.refreshToken}; engram-refresh=${fresh.refreshToken}`,
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://plexus.dev.ctxhost.com/health",
    );
    expect(mockPrisma.refreshToken.findUnique).toHaveBeenCalledTimes(2);
    expect(mockPrisma.refreshToken.deleteMany).not.toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("preserves client context on the refresh-token account fallback", async () => {
    const { refreshToken } = await generateTokenPair({
      id: "user-1",
      role: "USER",
    });
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "refresh" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      role: "USER",
      email: "user@example.com",
      orgMembers: [],
    });
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.refreshToken.create.mockResolvedValue({});
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?client_id=tradepost-web",
        `engram-refresh=${refreshToken}`,
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://login.dev.ctxhost.com/account?client_id=tradepost-web",
    );
  });

  it("falls back to the login page when refresh is unavailable", async () => {
    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fhealth",
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://login.dev.ctxhost.com/login?redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fhealth&rt=aHR0cHM6Ly9wbGV4dXMuZGV2LmN0eGhvc3QuY29tL2hlYWx0aA",
    );
  });

  it("falls back to the branded login page for an allowlisted auth host", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.ccgtradepost.com";

    const res = await GET(
      makeRequest(
        "https://auth.ccgtradepost.com/api/auth/continue?redirect_uri=%2Fauthorize%3Fresponse_type%3Dcode%26client_id%3Dtradepost-web",
        undefined,
        { host: "auth.ccgtradepost.com" },
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://auth.ccgtradepost.com/login?redirect_uri=%2Fauthorize%3Fresponse_type%3Dcode%26client_id%3Dtradepost-web&rt=L2F1dGhvcml6ZT9yZXNwb25zZV90eXBlPWNvZGUmY2xpZW50X2lkPXRyYWRlcG9zdC13ZWI&client_id=tradepost-web",
    );
  });

  it("keeps the global Tradepost landing fallback on the Tradepost auth host", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com,auth.ccgtradepost.com";
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = "https://ccgtradepost.com";

    const res = await GET(makeRequest(
      "https://auth.ccgtradepost.com/api/auth/continue",
      undefined,
      { host: "auth.ccgtradepost.com" },
    ));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://auth.ccgtradepost.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect_uri")).toBe("https://ccgtradepost.com");
  });

  it("keeps the global landing fallback on the canonical ctxhost login host", async () => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS = "login.ctxhost.com,auth.citethemove.com,auth.ccgtradepost.com";
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = "https://ccgtradepost.com";

    const res = await GET(makeRequest(
      "https://login.ctxhost.com/api/auth/continue",
      undefined,
      { host: "login.ctxhost.com" },
    ));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://login.ctxhost.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect_uri")).toBe("https://ccgtradepost.com");
  });

  it("revokes the family and redirects to login when the refresh token is not in the DB", async () => {
    const { refreshToken } = await generateTokenPair({ id: "user-1", role: "USER" });
    mockJwtVerify.mockResolvedValue({
      payload: { userId: "user-1", role: "USER", type: "refresh" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER" });
    // Consume finds nothing (updateMany count 0), token not in DB (findUnique
    // null → no grace) → family revoke + login (ADR-031).
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.refreshToken.findUnique.mockResolvedValue(null);
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 2 });

    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fhealth",
        `engram-refresh=${refreshToken}`,
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("preserves an external tenant redirect_uri when falling back to login", async () => {
    const res = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/auth/continue?redirect_uri=https%3A%2F%2Fcortex.dev.ctxhost.com%2F",
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://login.dev.ctxhost.com/login?redirect_uri=https%3A%2F%2Fcortex.dev.ctxhost.com%2F&rt=aHR0cHM6Ly9jb3J0ZXguZGV2LmN0eGhvc3QuY29tLw",
    );
  });

  // The route ACTUALLY receives this on Lambda: the runtime decoded the
  // percent-encoded "&", so redirect_uri arrives already split and client_id is
  // gone. Only the opaque target still carries the real destination. Asserted
  // on the ROUTE, so reverting the fix in the route fails this test.
  it("resumes from the opaque target when redirect_uri arrives split", async () => {
    const target = "/authorize?response_type=code&client_id=tradepost-web&app=tradepost";
    const rt = Buffer.from(target, "utf8").toString("base64url");

    const res = await GET(
      new NextRequest(
        new Request(
          `https://auth.ccgtradepost.com/api/auth/continue?redirect_uri=%2Fauthorize%3Fresponse_type%3Dcode&rt=${rt}`,
        ),
      ),
    );

    expect(res.status).toBe(307);
    const forwarded = new URL(res.headers.get("location") ?? "").searchParams;
    const resumed = Buffer.from(forwarded.get("rt") ?? "", "base64url").toString("utf8");

    expect(resumed).toBe(target);
    expect(resumed).toContain("client_id=tradepost-web");
    expect(forwarded.get("client_id")).toBe("tradepost-web");
  });
});
