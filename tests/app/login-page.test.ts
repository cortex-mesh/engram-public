import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ client_id: "tradepost-web" }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

import { mockPrisma } from "../mocks/prisma";
import LoginPage, { generateMetadata } from "@/app/(auth)/login/page";

describe("/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
  });

  it("server-renders Tradepost branding from an explicit client_id", async () => {
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

    const element = await LoginPage({
      searchParams: Promise.resolve({ client_id: "tradepost-web" }),
    });
    const html = renderToStaticMarkup(element);

    expect(mockPrisma.nativeAuthClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: "tradepost-web" } }),
    );
    expect(html).toContain("Access CCG Tradepost");
    expect(html).toContain("Trade cards with people you trust");
    expect(html).toContain("Sign in to continue to CCG Tradepost.");
    expect(html).toContain("Continue with Google");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("CORTEX");
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

  it("server-renders the default CORTEX headline and the mesh family row for a bare login", async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("One door into the mesh.");
    expect(html).toContain("Sign in once — your whole workspace opens.");
    expect(html).toContain("CORTEX mesh products");
    expect(html).toContain("Synapse");
    expect(html).toContain("Thoughts");
    expect(html).toContain("Pulse");
  });

  it("does not render the mesh family row for a resolved branded client", async () => {
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

    const element = await LoginPage({
      searchParams: Promise.resolve({ client_id: "tradepost-web" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).not.toContain("Synapse");
    expect(html).not.toContain("Thoughts");
    expect(html).not.toContain("Pulse");
    expect(html).not.toContain("CORTEX mesh products");
  });

  it("does not render the mesh family row for a resolved NON-Tradepost branded client", async () => {
    // Regression test for the server-side showMeshFamily computation itself.
    // The tradepost-web case above is independently suppressed by AuthShell's
    // own isTradepost defense-in-depth guard, so it stays green even if
    // showMeshFamily={!initialClientConfig.securedByEngram} were deleted or
    // broken — this uses a different branded client id to actually exercise
    // the server-side gate in isolation.
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

    const element = await LoginPage({
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
});
