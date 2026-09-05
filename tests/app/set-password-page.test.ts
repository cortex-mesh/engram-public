import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ token: "set-token", client_id: "tradepost-web" }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

import { mockPrisma } from "../mocks/prisma";
import SetPasswordPage, { generateMetadata } from "@/app/(auth)/set-password/page";

describe("/set-password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      if (model && typeof model === "object") {
        Object.values(model).forEach((fn) => (fn as { mockReset?: () => void }).mockReset?.());
      }
    });
  });

  it("server-renders Tradepost branding from client_id without CORTEX leakage", async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "tradepost-web",
      displayName: "CCG Tradepost",
      brandName: "CCG Tradepost",
      brandTagline: "Trade cards with people you trust",
      brandLogoUrl: null,
      brandPrimaryColor: "#0f766e",
      authProviders: ["google"],
      signupMode: "waitlist",
      enabled: true,
    });

    const element = await SetPasswordPage({
      searchParams: Promise.resolve({ token: "set-token", client_id: "tradepost-web" }),
    });
    const html = renderToStaticMarkup(element);

    expect(mockPrisma.nativeAuthClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: "tradepost-web" } }),
    );
    expect(html).toContain("CCG Tradepost");
    expect(html).toContain("Trade cards with people you trust");
    expect(html).toContain("Choose a password for your CCG Tradepost account.");
    expect(html).not.toContain("CORTEX");
  });

  it("uses Tradepost branding in metadata for client_id", async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "tradepost-web",
      displayName: "CCG Tradepost",
      brandName: "CCG Tradepost",
      brandTagline: "Trade cards with people you trust",
      brandLogoUrl: null,
      brandPrimaryColor: "#0f766e",
      authProviders: ["google"],
      signupMode: "waitlist",
      enabled: true,
    });

    await expect(
      generateMetadata({
        searchParams: Promise.resolve({ token: "set-token", client_id: "tradepost-web" }),
      }),
    ).resolves.toEqual({
      title: "CCG Tradepost",
      description: "Trade cards with people you trust",
    });
  });

  it("falls back to the CORTEX set-password surface without a client", async () => {
    const element = await SetPasswordPage({
      searchParams: Promise.resolve({ token: "set-token" }),
    });
    const html = renderToStaticMarkup(element);

    expect(mockPrisma.nativeAuthClient.findUnique).not.toHaveBeenCalled();
    expect(html).toContain("CORTEX");
    expect(html).toContain("Choose a password for your CORTEX account.");
  });

  it("does not render attacker-supplied client_id text", async () => {
    const element = await SetPasswordPage({
      searchParams: Promise.resolve({ token: "set-token", client_id: "CORTEX-free-password-audit" }),
    });
    const html = renderToStaticMarkup(element);

    expect(mockPrisma.nativeAuthClient.findUnique).not.toHaveBeenCalled();
    expect(html).toContain("CORTEX");
    expect(html).not.toContain("CORTEX-free-password-audit");
  });
});
