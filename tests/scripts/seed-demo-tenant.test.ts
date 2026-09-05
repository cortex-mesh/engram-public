import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import {
  ALLY_ORG_CONFIG,
  DEFAULT_CONFIG,
  selectTenantPreset,
} from "../../scripts/seed-demo-tenant.mjs";
import {
  CORTEX_SMOKE_APP_ENTITLEMENTS,
  CORTEX_SMOKE_MEMBER_CONFIG,
} from "../../scripts/seed-cortex-smoke-member.mjs";

describe("seed-demo-tenant fixture contract", () => {
  it("seeds the demo tenant host organization", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      orgName: "Demo",
      orgSlug: "demo",
    });
  });

  it("seeds the default owner and member accounts used by suite e2e", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      ownerEmail: "demo.owner@ctxhost.local",
      ownerUsername: "demo-owner",
      ownerDisplayName: "Demo Owner",
      memberEmail: "demo.member@ctxhost.local",
      memberUsername: "demo-member",
      memberDisplayName: "Demo Member",
    });
  });

  it("demo preset carries its own app and feature entitlement list", () => {
    expect(DEFAULT_CONFIG.appEntitlements).toEqual([
      "synapse",
      "thoughts",
      "pulse",
      "gyrus",
      "tradepost",
    ]);
    expect(DEFAULT_CONFIG.featureEntitlements).toEqual([
      { appKey: "thoughts", featureKey: "projects" },
    ]);
  });

  it("seeds the Ally Home Care org with PHI-free fake metadata (ADR-019)", () => {
    expect(ALLY_ORG_CONFIG).toMatchObject({
      orgName: "Ally Home Care",
      orgSlug: "ally",
      ownerEmail: "ally.owner@ctxhost.local",
      ownerUsername: "ally-owner",
      ownerDisplayName: "Ally Owner",
      memberEmail: "ally.member@ctxhost.local",
      memberUsername: "ally-member",
      memberDisplayName: "Ally Member",
    });
  });

  it("ally preset has synapse/pulse/thoughts entitlements and no feature flags", () => {
    expect(ALLY_ORG_CONFIG.appEntitlements).toEqual(["synapse", "pulse", "thoughts"]);
    expect(ALLY_ORG_CONFIG.featureEntitlements).toEqual([]);
  });

  it("selectTenantPreset returns the correct preset for each key", () => {
    expect(selectTenantPreset("ally")).toEqual(ALLY_ORG_CONFIG);
    expect(selectTenantPreset("demo")).toEqual(DEFAULT_CONFIG);
    expect(selectTenantPreset(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("selectTenantPreset throws on unknown presets", () => {
    expect(() => selectTenantPreset("home-care")).toThrow(/Unknown DEMO_TENANT_PRESET/);
    expect(() => selectTenantPreset("ally-home-care")).toThrow(/Unknown DEMO_TENANT_PRESET/);
  });

  it("exposes a repeatable ally tenant seed command", () => {
    expect(packageJson.scripts["seed:demo:ally"]).toBe(
      "DEMO_TENANT_PRESET=ally node scripts/seed-demo-tenant.mjs",
    );
  });

  it("seeds the dedicated non-owner Cortex smoke member", () => {
    expect(CORTEX_SMOKE_MEMBER_CONFIG).toMatchObject({
      orgName: "CORTEX",
      orgSlug: "cortex",
      email: "cortex.smoke.member@ctxhost.local",
      username: "cortex-smoke-member",
      displayName: "Smoke",
      role: "MEMBER",
    });
    expect(CORTEX_SMOKE_APP_ENTITLEMENTS).toEqual(["synapse"]);
    expect(packageJson.scripts["seed:cortex-smoke-member"]).toBe(
      "node scripts/seed-cortex-smoke-member.mjs",
    );
  });
});
