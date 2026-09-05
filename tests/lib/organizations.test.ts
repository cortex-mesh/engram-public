import { describe, expect, it, vi, afterEach } from "vitest";
import {
  RESERVED_ORG_SLUGS,
  getTenantBaseDomain,
  getTrustedPublicOrigins,
  hasCrossOriginCookieWrite,
  isTrustedPublicOrigin,
  validateOrganizationInput,
} from "@/lib/organizations";

describe("validateOrganizationInput", () => {
  it("accepts a well-formed name and slug", () => {
    const result = validateOrganizationInput({
      name: "Acme Inc",
      slug: "acme",
    });

    expect(result).toEqual({ data: { name: "Acme Inc", slug: "acme" } });
  });

  it("trims whitespace from name and slug", () => {
    const result = validateOrganizationInput({
      name: "  Acme Inc  ",
      slug: "  acme  ",
    });

    expect(result).toEqual({ data: { name: "Acme Inc", slug: "acme" } });
  });

  it("rejects a slug with invalid characters", () => {
    const result = validateOrganizationInput({
      name: "Acme",
      slug: "Acme!",
    });

    expect(result).toHaveProperty("error");
  });

  it("rejects missing name and slug when not partial", () => {
    const result = validateOrganizationInput({});
    expect(result).toHaveProperty("error");
  });

  it("rejects empty partial updates", () => {
    const result = validateOrganizationInput({ partial: true });
    expect(result).toEqual({
      error: "Provide at least one organization field to update.",
    });
  });

  it.each([...RESERVED_ORG_SLUGS])("rejects reserved slug %s", (slug) => {
    const result = validateOrganizationInput({ name: "Acme", slug });
    expect(result).toEqual({
      error: `Organization slug "${slug}" is reserved.`,
    });
  });

  it("rejects reserved slugs on partial updates too", () => {
    const result = validateOrganizationInput({
      slug: "plexus",
      partial: true,
    });
    expect(result).toEqual({
      error: 'Organization slug "plexus" is reserved.',
    });
  });

  it("does not reject slugs that merely contain a reserved word", () => {
    const result = validateOrganizationInput({
      name: "Plexus Labs",
      slug: "plexus-labs",
    });
    expect(result).toEqual({
      data: { name: "Plexus Labs", slug: "plexus-labs" },
    });
  });
});

describe("RESERVED_ORG_SLUGS", () => {
  it("contains the reserved subdomains used by hosted ctxhost surfaces", () => {
    expect(RESERVED_ORG_SLUGS).toEqual(
      expect.arrayContaining(["login", "platform", "plexus", "api"]),
    );
  });
});

describe("getTenantBaseDomain", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the parent domain of ENGRAM_URL", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.dev.ctxhost.com");
    expect(getTenantBaseDomain()).toBe("dev.ctxhost.com");
  });

  it("works for prod-style URLs without a dev subdomain", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    expect(getTenantBaseDomain()).toBe("ctxhost.com");
  });

  it("returns null when ENGRAM_URL is unset", () => {
    vi.stubEnv("ENGRAM_URL", "");
    expect(getTenantBaseDomain()).toBeNull();
  });
});

describe("isTrustedPublicOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("trusts tenant subdomains of the engram base domain automatically", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.dev.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");
    expect(isTrustedPublicOrigin("https://ally.dev.ctxhost.com")).toBe(true);
    expect(isTrustedPublicOrigin("https://cortex.dev.ctxhost.com")).toBe(true);
    expect(isTrustedPublicOrigin("https://demo.dev.ctxhost.com")).toBe(true);
  });

  it("trusts ENGRAM_URL itself", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.dev.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");
    expect(isTrustedPublicOrigin("https://login.dev.ctxhost.com")).toBe(true);
  });

  it("trusts origins in ENGRAM_ALLOWED_ORIGINS", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.dev.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "https://external.example.com");
    expect(isTrustedPublicOrigin("https://external.example.com")).toBe(true);
  });

  it("trusts origins derived from ENGRAM_ALLOWED_HOSTS", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.ccgtradepost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");

    expect(getTrustedPublicOrigins()).toEqual([
      "https://login.ctxhost.com",
      "https://auth.ccgtradepost.com",
    ]);
    expect(isTrustedPublicOrigin("https://auth.ccgtradepost.com")).toBe(true);
    expect(isTrustedPublicOrigin("https://auth.ccgtradepost.com.evil.com")).toBe(false);
  });

  it("does not treat an allowlisted host as a cross-origin cookie write", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.ccgtradepost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");

    const request = new Request("https://login.ctxhost.com/api/auth/set-password/request", {
      method: "POST",
      headers: {
        cookie: "engram-access=x",
        origin: "https://auth.ccgtradepost.com",
        host: "login.ctxhost.com",
      },
    });

    expect(hasCrossOriginCookieWrite(request)).toBe(false);
  });

  it("trusts the exact Cite auth origin for CORS and cookie-write CSRF checks", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.citethemove.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");

    const request = new Request("https://login.ctxhost.com/api/auth/set-password/request", {
      method: "POST",
      headers: {
        cookie: "engram-access=x",
        origin: "https://auth.citethemove.com",
        host: "login.ctxhost.com",
      },
    });

    expect(isTrustedPublicOrigin("https://auth.citethemove.com")).toBe(true);
    expect(hasCrossOriginCookieWrite(request)).toBe(false);
    expect(isTrustedPublicOrigin("https://auth.citethemove.com.evil.com")).toBe(false);
  });

  it("rejects an unrelated origin", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.dev.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");
    expect(isTrustedPublicOrigin("https://evil.example.com")).toBe(false);
  });

  it("rejects the bare base domain (not a tenant subdomain)", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.dev.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");
    expect(isTrustedPublicOrigin("https://dev.ctxhost.com")).toBe(false);
  });

  it("rejects a subdomain on a different protocol", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.dev.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");
    expect(isTrustedPublicOrigin("http://ally.dev.ctxhost.com")).toBe(false);
  });

  it("rejects a domain that only ends with the base domain string (suffix attack)", () => {
    vi.stubEnv("ENGRAM_URL", "https://login.dev.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_ORIGINS", "");
    expect(isTrustedPublicOrigin("https://evildev.ctxhost.com")).toBe(false);
  });
});
