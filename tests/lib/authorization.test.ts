import { describe, expect, it } from "vitest";

import {
  APP_KEYS,
  ORG_ROLES,
  PLATFORM_SUPERADMIN,
  isAppKey,
  isFeatureKey,
  isOrgManager,
  isOrgOwner,
  isPlatformSuperadmin,
} from "@/lib/authorization";
import { toOrganizationSummary } from "@/lib/organizations";

describe("authorization helpers", () => {
  it("recognizes the platform superadmin role", () => {
    expect(PLATFORM_SUPERADMIN).toBe("SUPERADMIN");
    expect(isPlatformSuperadmin("SUPERADMIN")).toBe(true);
    expect(isPlatformSuperadmin("ADMIN")).toBe(false);
    expect(isPlatformSuperadmin("USER")).toBe(false);
  });

  it("recognizes owner and manager org roles", () => {
    expect(ORG_ROLES).toEqual(["OWNER", "ADMIN", "MEMBER"]);
    expect(isOrgOwner("OWNER")).toBe(true);
    expect(isOrgOwner("ADMIN")).toBe(false);
    expect(isOrgManager("OWNER")).toBe(true);
    expect(isOrgManager("ADMIN")).toBe(true);
    expect(isOrgManager("MEMBER")).toBe(false);
  });

  it("validates app keys and feature keys", () => {
    expect(APP_KEYS).toEqual([
      "dashboard",
      "synapse",
      "thoughts",
      "axon",
      "pulse",
      "gyrus",
      "tradepost",
      "fieldops",
    ]);
    expect(isAppKey("thoughts")).toBe(true);
    expect(isAppKey("axon")).toBe(true);
    expect(isAppKey("pulse")).toBe(true);
    expect(isAppKey("gyrus")).toBe(true);
    expect(isAppKey("engram")).toBe(false);
    expect(isFeatureKey("thoughts", "projects")).toBe(true);
    expect(isFeatureKey("thoughts", "adr")).toBe(true);
    expect(isFeatureKey("thoughts", "billing")).toBe(false);
    expect(isFeatureKey("synapse", "projects")).toBe(false);
  });

  it("serializes organization summaries with explicit membership state", () => {
    const memberSummary = toOrganizationSummary({
      id: "org-1",
      name: "CORTEX",
      slug: "cortex",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-02T00:00:00.000Z"),
      _count: { members: 2 },
      members: [{ role: "ADMIN" }],
    });

    expect(memberSummary.role).toBe("ADMIN");
    expect(memberSummary.isMember).toBe(true);

    const superadminSummary = toOrganizationSummary({
      id: "org-2",
      name: "DBest",
      slug: "dbest",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-02T00:00:00.000Z"),
      _count: { members: 3 },
      roleOverride: "SUPERADMIN",
      isMemberOverride: false,
    });

    expect(superadminSummary.role).toBe("SUPERADMIN");
    expect(superadminSummary.isMember).toBe(false);
  });
});
