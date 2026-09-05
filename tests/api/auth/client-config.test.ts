import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { mockPrisma } from "../../mocks/prisma";
import { GET } from "@/app/api/auth/client-config/route";

function request(url: string, host: string) {
  return new NextRequest(url, { headers: { host } });
}

describe("GET /api/auth/client-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as { mockReset?: () => void }).mockReset?.());
    });
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "auth.citethemove.com");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("resolves bare Cite-host config as axon-web", async () => {
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

    const response = await GET(request("https://internal.example/api/auth/client-config", "auth.citethemove.com"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ clientId: "axon-web", brandName: "Cite the Move" });
  });

  it("does not let an allowlisted forwarded host bypass Cite client binding", async () => {
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

    const response = await GET(new NextRequest("https://internal.example/api/auth/client-config", {
      headers: {
        host: "auth.citethemove.com",
        "x-forwarded-host": "login.ctxhost.com",
      },
    }));
    await expect(response.json()).resolves.toMatchObject({
      clientId: "axon-web",
      brandName: "Cite the Move",
    });
  });

  it("rejects a conflicting client id before it can select another tenant", async () => {
    const response = await GET(
      request("https://internal.example/api/auth/client-config?client_id=tradepost-web", "auth.citethemove.com"),
    );
    expect(response.status).toBe(400);
    expect(mockPrisma.nativeAuthClient.findUnique).not.toHaveBeenCalled();
  });
});
