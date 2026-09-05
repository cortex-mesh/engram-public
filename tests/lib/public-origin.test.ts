import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAllowedPublicOrigins, getCanonicalPlatformOrigin, getPublicOrigin } from "@/lib/public-origin";

function request(headers?: HeadersInit) {
  return new NextRequest("https://internal.example.test/api/auth/magic-link", {
    headers,
  });
}

describe("public origin allowlist", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses an allowlisted request host for branded auth links", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.ccgtradepost.com");

    expect(getPublicOrigin(request({ host: "auth.ccgtradepost.com" }))).toBe(
      "https://auth.ccgtradepost.com",
    );
  });

  it("uses the Cite production auth host only on its exact allowlisted authority", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.citethemove.com");

    expect(getPublicOrigin(request({ host: "auth.citethemove.com" }))).toBe(
      "https://auth.citethemove.com",
    );
    expect(getPublicOrigin(request({ host: "auth.citethemove.com.evil.com" }))).toBe(
      "https://login.ctxhost.com",
    );
  });

  it("keeps the canonical platform origin on configured Engram rather than a branded request alias", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.citethemove.com");

    expect(getPublicOrigin(request({ host: "auth.citethemove.com" }))).toBe(
      "https://auth.citethemove.com",
    );
    expect(getCanonicalPlatformOrigin()).toBe("https://login.ctxhost.com");
  });

  it("prefers an allowlisted public Host over x-forwarded-host", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.ccgtradepost.com");

    expect(
      getPublicOrigin(
        request({
          host: "login.ctxhost.com",
          "x-forwarded-host": "auth.ccgtradepost.com, evil.example.com",
        }),
      ),
    ).toBe("https://login.ctxhost.com");
  });

  it("uses an allowlisted x-forwarded-host only when Host is internal or unrecognized", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.citethemove.com");

    expect(getPublicOrigin(request({
      host: "engram-internal",
      "x-forwarded-host": "auth.citethemove.com",
    }))).toBe("https://auth.citethemove.com");
  });

  it("preserves an allowlisted request port for on-prem links", () => {
    vi.stubEnv("ENGRAM_URL", "https://engram.rapidagent.dev:8443");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.rapidagent.dev:8443");

    expect(getPublicOrigin(request({ host: "login.rapidagent.dev:8443" }))).toBe(
      "https://login.rapidagent.dev:8443",
    );
  });

  it("falls back to ENGRAM_URL for spoofed and lookalike hosts", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.ccgtradepost.com");

    for (const host of ["evil.example.com", "auth.ccgtradepost.com.evil.com"]) {
      expect(getPublicOrigin(request({ host }))).toBe("https://login.ctxhost.com");
      expect(getPublicOrigin(request({ host: "login.ctxhost.com", "x-forwarded-host": host }))).toBe(
        "https://login.ctxhost.com",
      );
    }
  });

  it("exposes configured and allowlisted origins for CORS and CSRF", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.ccgtradepost.com");

    expect(getAllowedPublicOrigins()).toEqual([
      "https://login.ctxhost.com",
      "https://auth.ccgtradepost.com",
    ]);
  });

  it("exposes allowlisted origins with ports", () => {
    vi.stubEnv("ENGRAM_URL", "https://engram.rapidagent.dev:8443");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.rapidagent.dev:8443");

    expect(getAllowedPublicOrigins()).toEqual([
      "https://engram.rapidagent.dev:8443",
      "https://login.rapidagent.dev:8443",
    ]);
  });
});
