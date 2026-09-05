import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENGRAM_JWT_SECRET = "test-secret-for-magic-link-verify-tests";
process.env.ENGRAM_URL = "https://login.dev.ctxhost.com";

const { mockConsumeMagicLink } = vi.hoisted(() => ({
  mockConsumeMagicLink: vi.fn(),
}));

vi.mock("@/lib/db/magic-links", () => ({
  consumeMagicLink: mockConsumeMagicLink,
}));

import { mockPrisma } from "../../mocks/prisma";
import { GET, POST } from "@/app/api/auth/magic-link/verify/route";

const BASE = "https://login.dev.ctxhost.com";

function getReq(query: string) {
  return new NextRequest(`${BASE}/api/auth/magic-link/verify${query}`);
}

function postReq(
  fields: Record<string, string>,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
) {
  const body = new URLSearchParams(fields).toString();
  return new NextRequest(`${BASE}/api/auth/magic-link/verify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

describe("magic-link verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      if (model && typeof model === "object") {
        Object.values(model).forEach((fn) => (fn as { mockReset?: () => void }).mockReset?.());
      }
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER", emailVerified: true, orgMembers: [] });
    mockPrisma.refreshToken.create.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});
    process.env.ENGRAM_ALLOWED_HOSTS = "";
  });

  describe("GET (interstitial)", () => {
    it("renders an HTML form and does NOT consume the token (scanner-safe)", async () => {
      const res = await GET(getReq("?token=magic-123"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain('method="POST"');
      expect(html).toContain('name="token"');
      expect(html).toContain("magic-123");
      // Critically: a GET must not burn the one-time link.
      expect(mockConsumeMagicLink).not.toHaveBeenCalled();
    });

    it("redirects when the token is missing", async () => {
      const res = await GET(getReq(""));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("error=missing_token");
    });

    it("HTML-escapes the token", async () => {
      const res = await GET(getReq("?token=" + encodeURIComponent('"><script>x')));
      const html = await res.text();
      expect(html).not.toContain("<script>x");
      expect(html).toContain("&lt;script&gt;");
    });

    it("rejects a conflicting client id on the Cite host", async () => {
      process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
      const res = await GET(new NextRequest(
        `${BASE}/api/auth/magic-link/verify?token=magic-123&client_id=tradepost-web`,
        { headers: { host: "auth.citethemove.com" } },
      ));

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("error=invalid_client");
      expect(mockConsumeMagicLink).not.toHaveBeenCalled();
    });

    it("renders the resolved Cite the Move brand without changing the default CORTEX interstitial", async () => {
      process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
      mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
        clientId: "axon-web",
        displayName: "Cite the Move",
        brandName: "Cite the Move",
        brandTagline: "Market intelligence that moves with you.",
        brandLogoUrl: null,
        brandPrimaryColor: null,
        authProviders: ["google", "github"],
        signupMode: "waitlist",
        enabled: true,
      });

      const cite = await GET(new NextRequest(
        `${BASE}/api/auth/magic-link/verify?token=magic-123`,
        { headers: { host: "auth.citethemove.com" } },
      ));
      expect(await cite.text()).toContain("Sign in to Cite the Move");

      const cortex = await GET(getReq("?token=magic-456"));
      expect(await cortex.text()).toContain("Sign in to CORTEX");
    });

    it("rejects conflicting direct and nested client ids on the Cite host", async () => {
      process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
      const res = await GET(new NextRequest(
        `${BASE}/api/auth/magic-link/verify?token=magic-123&client_id=axon-web&redirect_uri=%2Fauthorize%3Fclient_id%3Dtradepost-web`,
        { headers: { host: "auth.citethemove.com" } },
      ));

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("error=invalid_client");
      expect(mockConsumeMagicLink).not.toHaveBeenCalled();
    });
  });

  describe("POST (consume)", () => {
    it("consumes the token and sets session cookies on a same-origin submit", async () => {
      mockConsumeMagicLink.mockResolvedValue({ valid: true, userId: "user-1" });

      const res = await POST(postReq({ token: "magic-123", redirect_uri: "" }));

      expect(mockConsumeMagicLink).toHaveBeenCalledWith("magic-123");
      expect(res.status).toBe(303);
      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => c.includes("engram-access="))).toBe(true);
      expect(cookies.some((c) => c.includes("engram-refresh="))).toBe(true);
    });

    it("preserves client context when a branded magic link falls back to account", async () => {
      mockConsumeMagicLink.mockResolvedValue({ valid: true, userId: "user-1" });

      const res = await POST(
        postReq({ token: "magic-123", redirect_uri: "", client_id: "tradepost-web" }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${BASE}/account?client_id=tradepost-web`);
    });

    it("keeps a Cite magic-link session on account instead of its org-member default target", async () => {
      process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
      mockConsumeMagicLink.mockResolvedValue({ valid: true, userId: "user-1" });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-1", role: "USER", emailVerified: true,
        orgMembers: [{ org: { id: "org-1", slug: "cortex" } }],
      });

      const res = await POST(new NextRequest(`${BASE}/api/auth/magic-link/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          host: "auth.citethemove.com",
        },
        body: new URLSearchParams({ token: "magic-123" }).toString(),
      }));

      expect(res.headers.get("location")).toBe("https://auth.citethemove.com/account?client_id=axon-web");
    });

    it("rejects a conflicting client id on the Cite host before consuming the token", async () => {
      process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
      mockConsumeMagicLink.mockResolvedValue({ valid: true, userId: "user-1" });
      const body = new URLSearchParams({ token: "magic-123", client_id: "tradepost-web" }).toString();
      const res = await POST(new NextRequest(`${BASE}/api/auth/magic-link/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          host: "auth.citethemove.com",
        },
        body,
      }));

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("error=invalid_client");
      expect(mockConsumeMagicLink).not.toHaveBeenCalled();
    });

    it.each([
      ["missing Cite client", null],
      ["disabled Cite client", { enabled: false, redirectUris: [{ id: "cite-callback" }] }],
      ["disabled Cite callback", { enabled: true, redirectUris: [] }],
    ])("does not send a magic-link session to a %s", async (_label, client) => {
      process.env.ENGRAM_ALLOWED_HOSTS = "auth.citethemove.com";
      mockConsumeMagicLink.mockResolvedValue({ valid: true, userId: "user-1" });
      mockPrisma.nativeAuthClient.findUnique.mockResolvedValue(client);
      const body = new URLSearchParams({
        token: "magic-123",
        redirect_uri: "https://app.citethemove.com/auth/callback",
      }).toString();

      const res = await POST(new NextRequest(`${BASE}/api/auth/magic-link/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          host: "auth.citethemove.com",
        },
        body,
      }));

      expect(res.headers.get("location")).toBe("https://auth.citethemove.com/account?client_id=axon-web");
    });

    it("rejects a cross-site POST without consuming (login-CSRF guard)", async () => {
      mockConsumeMagicLink.mockResolvedValue({ valid: true, userId: "user-1" });

      const res = await POST(
        postReq({ token: "magic-123" }, { "sec-fetch-site": "cross-site" }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("error=invalid_link");
      expect(mockConsumeMagicLink).not.toHaveBeenCalled();
    });

    it("redirects to an error when the token is invalid/expired", async () => {
      mockConsumeMagicLink.mockResolvedValue({ valid: false, reason: "expired" });
      const res = await POST(postReq({ token: "old" }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("error=link_expired");
    });

    it("redirects to missing_token when no token is posted", async () => {
      const res = await POST(postReq({}));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("error=missing_token");
    });
  });
});
