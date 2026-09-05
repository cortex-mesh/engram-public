import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSearchParams } = vi.hoisted(() => ({
  mockSearchParams: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => mockSearchParams(),
}));

import { buildLoginRequestContext, LoginForm } from "@/app/(auth)/login/login-form";

describe("LoginForm", () => {
  beforeEach(() => {
    mockSearchParams.mockReturnValue(new URLSearchParams({
      client_id: "tradepost-web",
      redirect_uri: "/authorize?response_type=code&client_id=tradepost-web",
    }));
  });

  it("omits an empty continuation from direct-login request bodies", () => {
    expect(buildLoginRequestContext("", null)).toEqual({});
    expect(buildLoginRequestContext("", "axon-web")).toEqual({ clientId: "axon-web" });
  });

  it("retains non-empty continuation and client context", () => {
    expect(buildLoginRequestContext("/authorize?client_id=axon-web", "axon-web")).toEqual({
      redirectUri: "/authorize?client_id=axon-web",
      clientId: "axon-web",
    });
  });

  it("renders direct OAuth links without an explicit empty redirect_uri", () => {
    mockSearchParams.mockReturnValue(new URLSearchParams());
    const html = renderToStaticMarkup(
      createElement(LoginForm, {
        initialClientConfig: {
          clientId: null,
          brandName: "CORTEX",
          brandTagline: "One door into the mesh.",
          authProviders: ["google", "github"],
          signupMode: "waitlist",
          securedByEngram: false,
        },
      }),
    );

    expect(html).toContain('href="/api/auth/oauth/google"');
    expect(html).toContain('href="/api/auth/oauth/github"');
    expect(html).not.toContain("redirect_uri=");
  });

  it("keeps a direct Cite-host OAuth link bound to axon-web without a blank continuation", () => {
    mockSearchParams.mockReturnValue(new URLSearchParams());
    const html = renderToStaticMarkup(
      createElement(LoginForm, {
        initialClientConfig: {
          clientId: "axon-web",
          brandName: "Cite the Move",
          brandTagline: "Secure sign-in for your workspace",
          authProviders: ["github"],
          signupMode: "waitlist",
          securedByEngram: true,
        },
      }),
    );

    expect(html).toContain('href="/api/auth/oauth/github?client_id=axon-web"');
    expect(html).not.toContain("redirect_uri=");
  });

  it("renders the initial Tradepost client branding without a CORTEX fallback", () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, {
        initialClientConfig: {
          clientId: "tradepost-web",
          brandName: "CCG Tradepost",
          brandTagline: "Trade cards with people you trust",
          authProviders: ["google"],
          signupMode: "waitlist",
          securedByEngram: true,
        },
      }),
    );

    expect(html).toContain("Access CCG Tradepost");
    // The card description no longer duplicates the branded tagline (ADR-029
    // D6 dedup fix) — AuthShell's own headline is the only place it renders,
    // and AuthShell isn't part of this isolated LoginForm render.
    expect(html).not.toContain("Trade cards with people you trust");
    expect(html).toContain("Continue with Google");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("Access CORTEX");
  });
});
