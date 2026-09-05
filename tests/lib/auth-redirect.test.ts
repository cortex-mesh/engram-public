import { describe, expect, it, vi } from "vitest";
import { getSafeRedirectTarget, isAllowedRedirect } from "@/lib/auth-redirect";

describe("auth redirect validation", () => {
  it("allows a normal relative path", () => {
    expect(isAllowedRedirect("/chat")).toBe(true);
  });

  it("allows redirects to registered app origins, including pulse", () => {
    expect(isAllowedRedirect("https://cortex.dev.ctxhost.com/pulse")).toBe(true);
    expect(isAllowedRedirect("https://cortex.dev.ctxhost.com/gyrus")).toBe(true);
  });

  it("allows tenant-host redirects under the dev ctxhost wildcard", () => {
    expect(isAllowedRedirect("https://cortex.dev.ctxhost.com/")).toBe(true);
    expect(isAllowedRedirect("https://dbest.dev.ctxhost.com/synapse")).toBe(
      true,
    );
  });

  it("rejects wildcard redirects outside the ctxhost tenant roots", () => {
    expect(
      isAllowedRedirect("https://evil.dashboard.rapidagent.dev:8443/"),
    ).toBe(false);
  });

  it("rejects the retired dashboard.rapidagent.dev alias by default", () => {
    expect(isAllowedRedirect("https://dashboard.rapidagent.dev:8443/")).toBe(
      false,
    );
  });

  it("rejects reserved hosts under the on-prem tenant wildcard", async () => {
    const previousEnv = {
      NEXT_PUBLIC_DASHBOARD_URL: process.env.NEXT_PUBLIC_DASHBOARD_URL,
      NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING:
        process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING,
      NEXT_PUBLIC_PLATFORM_ADMIN_URL:
        process.env.NEXT_PUBLIC_PLATFORM_ADMIN_URL,
      NEXT_PUBLIC_SYNAPSE_URL: process.env.NEXT_PUBLIC_SYNAPSE_URL,
    };

    process.env.NEXT_PUBLIC_DASHBOARD_URL = "https://plexus.rapidagent.dev:8443";
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING =
      "https://lab.rapidagent.dev:8443/";
    process.env.NEXT_PUBLIC_PLATFORM_ADMIN_URL =
      "https://platform.rapidagent.dev:8443/admin";
    process.env.NEXT_PUBLIC_SYNAPSE_URL =
      "https://lab.rapidagent.dev:8443/synapse";

    try {
      vi.resetModules();
      const { isAllowedRedirect } = await import("@/lib/auth-redirect");

      expect(isAllowedRedirect("https://lab.rapidagent.dev:8443/synapse")).toBe(
        true,
      );
      expect(isAllowedRedirect("https://dashboard.rapidagent.dev:8443/")).toBe(
        false,
      );
      expect(
        isAllowedRedirect("https://evil.dashboard.rapidagent.dev:8443/"),
      ).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    }
  });

  it("refuses an unconfigured app redirect in production without throwing", async () => {
    const previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      ENGRAM_URL: process.env.ENGRAM_URL,
      NEXT_PUBLIC_DASHBOARD_URL: process.env.NEXT_PUBLIC_DASHBOARD_URL,
      NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING:
        process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING,
      NEXT_PUBLIC_PLATFORM_ADMIN_URL:
        process.env.NEXT_PUBLIC_PLATFORM_ADMIN_URL,
      NEXT_PUBLIC_PULSE_URL: process.env.NEXT_PUBLIC_PULSE_URL,
    };

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING", "");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_URL", "");
    vi.stubEnv("NEXT_PUBLIC_PULSE_URL", "");

    try {
      vi.resetModules();
      const { isAllowedRedirect } = await import("@/lib/auth-redirect");

      expect(() => isAllowedRedirect("https://cortex.dev.ctxhost.com/pulse")).not.toThrow();
      expect(isAllowedRedirect("https://cortex.dev.ctxhost.com/pulse")).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    }
  });

  it("rejects dev/stg/staging wildcard tenant redirects in a prod-like config", async () => {
    const previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      ENGRAM_URL: process.env.ENGRAM_URL,
      ENGRAM_ALLOWED_HOSTS: process.env.ENGRAM_ALLOWED_HOSTS,
      NEXT_PUBLIC_DASHBOARD_URL: process.env.NEXT_PUBLIC_DASHBOARD_URL,
      NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING:
        process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING,
      NEXT_PUBLIC_PLATFORM_ADMIN_URL:
        process.env.NEXT_PUBLIC_PLATFORM_ADMIN_URL,
      NEXT_PUBLIC_SYNAPSE_URL: process.env.NEXT_PUBLIC_SYNAPSE_URL,
    };

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,platform.ctxhost.com");
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING", "");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_URL", "https://platform.ctxhost.com/admin");
    vi.stubEnv("NEXT_PUBLIC_SYNAPSE_URL", "");

    try {
      vi.resetModules();
      const { isAllowedRedirect } = await import("@/lib/auth-redirect");

      expect(isAllowedRedirect("https://demo.ctxhost.com/")).toBe(true);
      expect(isAllowedRedirect("https://dev.ctxhost.com/")).toBe(false);
      expect(isAllowedRedirect("https://stg.ctxhost.com/")).toBe(false);
      expect(isAllowedRedirect("https://staging.ctxhost.com/")).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    }
  });

  it("rejects tenant-host redirects on the wrong port", () => {
    expect(isAllowedRedirect("https://cortex.dev.ctxhost.com:444/")).toBe(
      false,
    );
  });

  it("rejects protocol-relative redirects", () => {
    expect(isAllowedRedirect("//evil.com/pwn")).toBe(false);
    expect(
      getSafeRedirectTarget(
        "//evil.com/pwn",
        "https://plexus.dev.ctxhost.com",
      ),
    ).toBe("https://plexus.dev.ctxhost.com");
  });
});
