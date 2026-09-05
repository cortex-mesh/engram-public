import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ client_id: "tradepost-web" }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

import { mockPrisma } from "../mocks/prisma";
import RegisterPage, { generateMetadata } from "@/app/(auth)/register/page";

describe("/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
  });

  it("server-renders the default CORTEX headline and the mesh family row for a bare register", async () => {
    const element = await RegisterPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("One door into the mesh.");
    expect(html).toContain("Request access to your workspace.");
    expect(html).toContain("mesh-family-row");
    expect(html).toContain("Synapse");
    expect(html).toContain("Thoughts");
    expect(html).toContain("Pulse");
  });

  it("server-renders Tradepost branding from an explicit client_id, no mesh family row", async () => {
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

    const element = await RegisterPage({
      searchParams: Promise.resolve({ client_id: "tradepost-web" }),
    });
    const html = renderToStaticMarkup(element);

    expect(mockPrisma.nativeAuthClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: "tradepost-web" } }),
    );
    expect(html).toContain("CCG Tradepost");
    expect(html).not.toContain("mesh-family-row");
    expect(html).not.toContain("Synapse");
    expect(html).not.toContain("CORTEX mesh products");
  });

  it("does not render the mesh family row for a resolved NON-Tradepost branded client", async () => {
    // Same rationale as the login-page regression test: the tradepost-web
    // case above is independently suppressed by AuthShell's own isTradepost
    // guard, so it can't catch a broken showMeshFamily computation on its
    // own — this exercises the server-side gate directly.
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "acme-web",
      displayName: "Acme",
      brandName: "Acme",
      brandTagline: "Sign in to Acme",
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ["google"],
      signupMode: "waitlist",
      enabled: true,
    });

    const element = await RegisterPage({
      searchParams: Promise.resolve({ client_id: "acme-web" }),
    });
    const html = renderToStaticMarkup(element);

    expect(mockPrisma.nativeAuthClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: "acme-web" } }),
    );
    expect(html).not.toContain("mesh-family-row");
    expect(html).not.toContain("Synapse");
    expect(html).not.toContain("Thoughts");
    expect(html).not.toContain("Pulse");
    expect(html).not.toContain("CORTEX mesh products");
  });

  it("uses Tradepost branding in server metadata for an explicit client_id", async () => {
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
        searchParams: Promise.resolve({ client_id: "tradepost-web" }),
      }),
    ).resolves.toEqual({
      title: "CCG Tradepost",
      description: "Trade cards with people you trust",
    });
  });
});
