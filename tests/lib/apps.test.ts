import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  platformUrl: "https://platform.dev.ctxhost.com/admin",
}));

vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_URL", env.platformUrl);

import {
  DEFAULT_PLATFORM_ADMIN_URL,
  PLATFORM_APPS,
  derivePlatformAdminUrlFromEngramUrl,
  getAppUrl,
  getCortexApps,
  getDefaultLandingUrl,
  getDefaultPostLoginTarget,
  getOptionalPlatformAdminUrl,
  getPlatformAdminUrl,
} from "@/lib/apps";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_URL", env.platformUrl);
});

describe("platform admin host helpers", () => {
  it("registers Gyrus in the platform app catalog", () => {
    expect(PLATFORM_APPS.find((app) => app.key === "gyrus")).toMatchObject({
      key: "gyrus",
      name: "Gyrus",
      envVar: "NEXT_PUBLIC_GYRUS_URL",
      defaultUrl: "https://cortex.dev.ctxhost.com/gyrus",
    });
  });

  it("defaults the platform admin host to platform.dev.ctxhost.com in dev", () => {
    expect(DEFAULT_PLATFORM_ADMIN_URL).toBe("https://platform.dev.ctxhost.com/admin");
  });

  it("uses the configured platform admin URL when present", () => {
    expect(getPlatformAdminUrl()).toBe(env.platformUrl);
  });

  it("derives the platform admin URL from ENGRAM_URL when no explicit URL is set", () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_URL", "");
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");

    expect(getPlatformAdminUrl()).toBe("https://platform.ctxhost.com/admin");
  });

  it("omits the platform admin URL in production when it is missing and cannot be derived", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_URL", "");
    vi.stubEnv("ENGRAM_URL", "");

    expect(getOptionalPlatformAdminUrl()).toBeNull();
    expect(getPlatformAdminUrl()).toBe("");
  });

  it("derives the platform admin URL from the on-prem transitional Engram host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_URL", "");
    vi.stubEnv("ENGRAM_URL", "https://engram.rapidagent.dev:8443");

    expect(getOptionalPlatformAdminUrl()).toBe("https://platform.rapidagent.dev:8443/admin");
    expect(getPlatformAdminUrl()).toBe("https://platform.rapidagent.dev:8443/admin");
  });

  it("omits an app URL in production when it would otherwise fall back to dev", () => {
    const [app] = PLATFORM_APPS;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(app.envVar, "");

    expect(getAppUrl(app)).toBe("");
  });

  it("uses an account-relative landing URL in production instead of falling back to dev", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING", "");
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "");
    const { getDefaultLandingUrl } = await import("@/lib/apps");

    expect(getDefaultLandingUrl()).toBe("/account");
  });

  it("resolves the default landing URL from runtime env after module import", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING", "");
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "");

    expect(getDefaultLandingUrl()).toBe("/account");

    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "https://plexus.runtime.ctxhost.com");

    expect(getDefaultLandingUrl()).toBe("https://plexus.runtime.ctxhost.com");
  });

  it("drops all app launcher entries in production when app URLs are not configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const app of PLATFORM_APPS) {
      vi.stubEnv(app.envVar, "");
    }

    expect(getCortexApps()).toEqual([]);
  });

  it("keeps the Engram-to-platform derivation explicit", () => {
    expect(derivePlatformAdminUrlFromEngramUrl("https://login.dev.ctxhost.com")).toBe(
      "https://platform.dev.ctxhost.com/admin",
    );
  });

  it("sends superadmins to the platform admin host by default", () => {
    expect(getDefaultPostLoginTarget({ role: "SUPERADMIN" })).toBe(env.platformUrl);
  });

  it("sends superadmins to /account when production has no platform admin URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_URL", "");
    vi.stubEnv("ENGRAM_URL", "");

    expect(getDefaultPostLoginTarget({ role: "SUPERADMIN" })).toBe("/account");
  });

  it("sends single-org users to their Nexus tenant host by default", () => {
    expect(
      getDefaultPostLoginTarget({
        role: "USER",
        orgMemberships: [{ org: { id: "org-1", slug: "cortex" } }],
      }),
    ).toBe("https://cortex.dev.ctxhost.com/");
  });

  it("routes SUPERADMINs to their tenant workspace when preferWorkspace is set", () => {
    expect(
      getDefaultPostLoginTarget({
        role: "SUPERADMIN",
        orgMemberships: [{ org: { id: "org-1", slug: "cortex" } }],
        preferWorkspace: true,
      }),
    ).toBe("https://cortex.dev.ctxhost.com/");
  });

  it("routes multi-org users to the oldest membership when no lastOrgId set", () => {
    expect(
      getDefaultPostLoginTarget({
        role: "USER",
        orgMemberships: [
          { org: { id: "org-1", slug: "cortex" } },
          { org: { id: "org-2", slug: "dbest" } },
        ],
      }),
    ).toBe("https://cortex.dev.ctxhost.com/");
  });

  it("routes multi-org users to lastOrgId when it is a current membership", () => {
    expect(
      getDefaultPostLoginTarget({
        role: "USER",
        orgMemberships: [
          { org: { id: "org-1", slug: "cortex" } },
          { org: { id: "org-2", slug: "dbest" } },
        ],
        lastOrgId: "org-2",
      }),
    ).toBe("https://dbest.dev.ctxhost.com/");
  });

  it("falls back to oldest membership when lastOrgId is no longer a member", () => {
    expect(
      getDefaultPostLoginTarget({
        role: "USER",
        orgMemberships: [
          { org: { id: "org-1", slug: "cortex" } },
          { org: { id: "org-2", slug: "dbest" } },
        ],
        lastOrgId: "org-removed",
      }),
    ).toBe("https://cortex.dev.ctxhost.com/");
  });

  it("falls back to /account when no org context is available", () => {
    expect(getDefaultPostLoginTarget({ role: "USER" })).toBe("/account");
    expect(getDefaultPostLoginTarget({})).toBe("/account");
  });

  it("falls back to /account when a SUPERADMIN opts into workspace mode with no tenant context", () => {
    expect(
      getDefaultPostLoginTarget({
        role: "SUPERADMIN",
        preferWorkspace: true,
      }),
    ).toBe("/account");
  });

  it("preserves the configured platform port for on-prem tenant redirects", async () => {
    vi.resetModules();
    vi.stubEnv(
      "NEXT_PUBLIC_PLATFORM_ADMIN_URL",
      "https://platform.rapidagent.dev:8443/admin",
    );
    const { getDefaultPostLoginTarget: getOnPremTarget } = await import("@/lib/apps");

    expect(
      getOnPremTarget({
        role: "USER",
        orgMemberships: [{ org: { id: "org-1", slug: "lab" } }],
      }),
    ).toBe("https://lab.rapidagent.dev:8443/");
  });
});
