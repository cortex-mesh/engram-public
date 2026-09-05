import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockPrisma } from "../mocks/prisma";
import {
  getEmailIdentityForClient,
  renderApprovalSetPasswordEmail,
  renderWaitlistConfirmationEmail,
} from "@/lib/email";

describe("email identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    process.env.EMAIL_FROM = "CORTEX <noreply@ctxhost.com>";
    delete process.env.ENGRAM_URL;
    delete process.env.EMAIL_VERIFIED_DOMAINS;
    Object.values(mockPrisma).forEach((model) => {
      if (model && typeof model === "object") {
        Object.values(model).forEach((fn) => (fn as { mockReset?: () => void }).mockReset?.());
      }
    });
  });

  it("falls back to CORTEX for unknown clients", async () => {
    const identity = await getEmailIdentityForClient(null);

    expect(identity).toMatchObject({
      clientId: null,
      brandName: "CORTEX",
      from: "CORTEX <noreply@ctxhost.com>",
      securedByEngram: false,
    });
    expect(mockPrisma.nativeAuthClient.findUnique).not.toHaveBeenCalled();
  });

  it("uses client branding while falling back to the verified sender domain", async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "tradepost-web",
      displayName: "CCG Tradepost",
      brandName: "CCG Tradepost",
      brandPrimaryColor: "#0f766e",
      emailFromName: "CCG Tradepost",
      emailFromAddress: "noreply@ccgtradepost.com",
      emailTemplateTheme: "tradepost",
      enabled: true,
    });

    const identity = await getEmailIdentityForClient("tradepost-web");

    expect(identity).toMatchObject({
      clientId: "tradepost-web",
      brandName: "CCG Tradepost",
      fromName: "CCG Tradepost",
      fromAddress: "noreply@ctxhost.com",
      from: "CCG Tradepost <noreply@ctxhost.com>",
      templateTheme: "tradepost",
      securedByEngram: true,
    });
  });

  it("uses the client sender address after its domain is configured as verified", async () => {
    process.env.EMAIL_VERIFIED_DOMAINS = "ccgtradepost.com";
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "tradepost-web",
      displayName: "CCG Tradepost",
      brandName: "CCG Tradepost",
      brandPrimaryColor: "#0f766e",
      emailFromName: "CCG Tradepost",
      emailFromAddress: "noreply@ccgtradepost.com",
      emailTemplateTheme: "tradepost",
      enabled: true,
    });

    const identity = await getEmailIdentityForClient("tradepost-web");

    expect(identity.from).toBe("CCG Tradepost <noreply@ccgtradepost.com>");
  });

  it("resolves Cite the Move email identity through the verified Engram sender", async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: "axon-web",
      displayName: "Cite the Move",
      brandName: "Cite the Move",
      brandPrimaryColor: null,
      emailFromName: "Cite the Move",
      emailFromAddress: null,
      emailTemplateTheme: null,
      enabled: true,
    });

    await expect(getEmailIdentityForClient("axon-web")).resolves.toMatchObject({
      clientId: "axon-web",
      brandName: "Cite the Move",
      fromName: "Cite the Move",
      fromAddress: "noreply@ctxhost.com",
      from: "Cite the Move <noreply@ctxhost.com>",
      securedByEngram: true,
    });
  });

  it("only uses a client sender address when its domain is verified", async () => {
    const client = {
      clientId: "tradepost-web",
      displayName: "CCG Tradepost",
      brandName: "CCG Tradepost",
      brandPrimaryColor: "#0f766e",
      emailFromName: "CCG Tradepost",
      emailFromAddress: "noreply@ccgtradepost.com",
      emailTemplateTheme: "tradepost",
      enabled: true,
    };
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue(client);

    process.env.EMAIL_VERIFIED_DOMAINS = "ctxhost.com";
    await expect(getEmailIdentityForClient("tradepost-web")).resolves.toMatchObject({
      fromAddress: "noreply@ctxhost.com",
      from: "CCG Tradepost <noreply@ctxhost.com>",
    });

    process.env.EMAIL_VERIFIED_DOMAINS = "ctxhost.com,ccgtradepost.com";
    await expect(getEmailIdentityForClient("tradepost-web")).resolves.toMatchObject({
      fromAddress: "noreply@ccgtradepost.com",
      from: "CCG Tradepost <noreply@ccgtradepost.com>",
    });
  });

  it("renders branded html and plain-text alternatives", async () => {
    const identity = {
      clientId: "tradepost-web",
      brandName: "CCG Tradepost",
      fromName: "CCG Tradepost",
      fromAddress: "noreply@ctxhost.com",
      from: "CCG Tradepost <noreply@ctxhost.com>",
      primaryColor: "#0f766e",
      templateTheme: "tradepost" as const,
      securedByEngram: true,
    };

    const waitlist = renderWaitlistConfirmationEmail(identity, "https://login.ctxhost.com");
    const approval = renderApprovalSetPasswordEmail(identity, "https://login.dev.ctxhost.com/set-password?token=x");

    expect(waitlist.html).toContain("CCG Tradepost sign-in is secured by Engram");
    expect(waitlist.text).toContain("You're on the CCG Tradepost waitlist");
    expect(waitlist.text).toContain("Visit the sign-in page: https://login.ctxhost.com");
    expect(approval.subject).toBe("You're in — set up your CCG Tradepost account");
    expect(approval.text).toContain("Set my password: https://login.dev.ctxhost.com/set-password?token=x");
  });

  it("renders Cite the Move waitlist and approval emails without leaking another client brand", () => {
    const identity = {
      clientId: "axon-web",
      brandName: "Cite the Move",
      fromName: "Cite the Move",
      fromAddress: "noreply@ctxhost.com",
      from: "Cite the Move <noreply@ctxhost.com>",
      primaryColor: "#2563eb",
      templateTheme: "cortex" as const,
      securedByEngram: true,
    };

    const waitlist = renderWaitlistConfirmationEmail(identity, "https://login.dev.ctxhost.com");
    const approval = renderApprovalSetPasswordEmail(
      identity,
      "https://login.dev.ctxhost.com/set-password?token=x",
    );

    expect(waitlist.subject).toBe("You're on the Cite the Move waitlist");
    expect(waitlist.html).toContain("Cite the Move sign-in is secured by Engram");
    expect(waitlist.text).toContain("We invite people in batches");
    expect(waitlist.html).not.toContain("CCG Tradepost");
    expect(approval.subject).toBe("You're in — set up your Cite the Move account");
    expect(approval.html).toContain("Set up your Cite the Move account");
    expect(approval.text).toContain("Cite the Move sign-in is secured by Engram");
    expect(approval.html).not.toContain("CCG Tradepost");
  });

  it("uses the waitlist sign-in URL supplied by the route", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_URL", "");
    const identity = {
      clientId: "tradepost-web",
      brandName: "CCG Tradepost",
      fromName: "CCG Tradepost",
      fromAddress: "noreply@ctxhost.com",
      from: "CCG Tradepost <noreply@ctxhost.com>",
      primaryColor: "#0f766e",
      templateTheme: "tradepost" as const,
      securedByEngram: true,
    };

    expect(
      renderWaitlistConfirmationEmail(identity, "https://tradepost.ctxhost.com/login").text,
    ).toContain("Visit the sign-in page: https://tradepost.ctxhost.com/login");
  });
});
