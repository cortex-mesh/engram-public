import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
  Space_Grotesk: () => ({ variable: "font-space-grotesk" }),
}));

import { metadata } from "@/app/layout";
import { AuthCardIntro } from "@/components/auth/auth-card-intro";
import { AuthShell } from "@/components/auth/auth-shell";

describe("CORTEX brand metadata", () => {
  it("does not expose the Engram infrastructure name in the browser title", () => {
    expect(metadata.title).toBe("CORTEX");
    expect(metadata.description).toBe(
      "Hosted sign-in and identity for CORTEX workspaces",
    );
  });
});

describe("AuthShell", () => {
  it("brands the auth surface as CORTEX instead of Engram", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        null,
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).toContain("CORTEX");
    expect(html).not.toContain("Engram");
    expect(html).toContain("One door into the mesh.");
    expect(html).toContain("mesh-auth-shell");
    expect(html).toContain("mesh-auth-shell__mark");
  });

  it("accepts client-specific shell branding", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        {
          brandName: "CCG Tradepost",
          brandTagline: "Trade cards with people you trust",
          supportingCopy: "Sign in to continue to CCG Tradepost.",
        },
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).toContain("CCG Tradepost");
    expect(html).toContain("Trade cards with people you trust");
    expect(html).toContain("Sign in to continue to CCG Tradepost.");
    expect(html).not.toContain("CORTEX");
  });

  it("renders the Tradepost wordmark only for the Tradepost theme", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        {
          brandTheme: "tradepost",
          brandName: "CCG Tradepost",
          brandTagline: "Trade cards with people you trust",
        },
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).toContain('data-brand-theme="tradepost"');
    expect(html).toContain("CCG TRADEPOST");
    expect(html).toContain("mesh-auth-shell__tradepost-mark");
    expect(html).not.toContain("mesh-auth-shell__mark-node--core");
  });

  it("renders Cite the Move's wordmark without inheriting Tradepost markup", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        {
          brandTheme: "citethemove",
          brandName: "Cite the Move",
          brandTagline: "Market intelligence that moves with you.",
        },
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).toContain('data-brand-theme="citethemove"');
    expect(html).toContain("CITE THE MOVE");
    expect(html).toContain("mesh-auth-shell__citethemove-mark");
    expect(html).not.toContain("CCG TRADEPOST");
    expect(html).not.toContain("mesh-ambient");
  });
});

describe("AuthShell mesh family row (ADR-029 D.5)", () => {
  it("does not render the mesh family row by default", () => {
    const html = renderToStaticMarkup(
      createElement(AuthShell, null, createElement("div", null, "Child content")),
    );

    expect(html).not.toContain("mesh-family-row");
    expect(html).not.toContain("CORTEX mesh products");
  });

  it("renders Synapse, Thoughts, Pulse when showMeshFamily is true", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        { showMeshFamily: true },
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).toContain("mesh-family-row");
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("CORTEX mesh products:");
    expect(html).toContain("Synapse");
    expect(html).toContain("Thoughts");
    expect(html).toContain("Pulse");
  });

  it("never renders the mesh family row for the Tradepost theme, even if showMeshFamily is true", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        {
          brandTheme: "tradepost",
          brandName: "CCG Tradepost",
          showMeshFamily: true,
        },
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).not.toContain("mesh-family-row");
    expect(html).not.toContain("Synapse");
    expect(html).not.toContain("Thoughts");
    expect(html).not.toContain("Pulse");
  });

  it("never renders the mesh family row for the Cite theme", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        { brandTheme: "citethemove", brandName: "Cite the Move", showMeshFamily: true },
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).not.toContain("mesh-family-row");
    expect(html).not.toContain("Synapse");
  });
});

describe("AuthShell brandLogoUrl (ADR-029 D.3)", () => {
  it("renders an img instead of the SVG mark when brandLogoUrl is set", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        { brandLogoUrl: "https://example.com/logo.png" },
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).toContain("mesh-auth-shell__mark-logo");
    expect(html).toContain("https://example.com/logo.png");
    expect(html).not.toContain("mesh-mark__ring");
  });

  it("ignores brandLogoUrl for the Tradepost theme, which owns its own wordmark", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthShell,
        {
          brandTheme: "tradepost",
          brandName: "CCG Tradepost",
          brandLogoUrl: "https://example.com/logo.png",
        },
        createElement("div", null, "Child content"),
      ),
    );

    expect(html).not.toContain("mesh-auth-shell__mark-logo");
    expect(html).toContain("mesh-auth-shell__tradepost-mark");
  });
});

describe("AuthCardIntro", () => {
  it("renders first-time friendly login card heading and supporting copy", () => {
    const html = renderToStaticMarkup(
      createElement(AuthCardIntro, {
        eyebrow: "Sign in",
        title: "Access your workspace",
        description:
          "Use your email, password, or a trusted provider to continue.",
      }),
    );

    expect(html).toContain("Sign in");
    expect(html).toContain("Access your workspace");
    expect(html).not.toContain("Welcome back");
    expect(html).toContain(
      "Use your email, password, or a trusted provider to continue.",
    );
    expect(html).toContain("mesh-auth-card-intro");
  });

  it("renders the waitlist heading and supporting copy", () => {
    const html = renderToStaticMarkup(
      createElement(AuthCardIntro, {
        eyebrow: "Request access",
        title: "Join the waitlist",
        description:
          "Self-service account creation is disabled. Request access to CORTEX and we’ll follow up when your workspace is ready.",
      }),
    );

    expect(html).toContain("Request access");
    expect(html).toContain("Join the waitlist");
    expect(html).toContain("Request access to CORTEX");
  });
});
