import { describe, expect, it } from "vitest";

import type { OrganizationSummary } from "@/lib/organizations";
import {
  getOrganizationAppAdmission,
  getOrganizationFeatureAdmission,
  listOrganizationsWithAppAccess,
} from "@/lib/entitlements";

function makeOrganization(
  overrides: Partial<OrganizationSummary> = {},
): OrganizationSummary {
  return {
    id: "org-1",
    name: "CORTEX",
    slug: "cortex",
    role: "USER",
    isMember: true,
    appEntitlements: [],
    featureEntitlements: [],
    userAppOverrides: [],
    appAccess: [],
    memberCount: 3,
    pendingInviteCount: 0,
    latestActivityAt: "2026-04-02T00:00:00.000Z",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("entitlement admission helpers", () => {
  it("allows app admission for org members with an enabled app entitlement", () => {
    const admission = getOrganizationAppAdmission(
      makeOrganization({
        role: "USER",
        isMember: true,
        appEntitlements: [{ appKey: "synapse", enabled: true }],
      }),
      "synapse",
    );

    expect(admission).toEqual({
      allowed: true,
      reason: null,
      member: true,
      appEntitled: true,
    });
  });

  it("denies app admission when the user is not an org member even if they have a privileged platform role", () => {
    const admission = getOrganizationAppAdmission(
      makeOrganization({
        role: "SUPERADMIN",
        isMember: false,
        appEntitlements: [{ appKey: "synapse", enabled: true }],
      }),
      "synapse",
    );

    expect(admission).toEqual({
      allowed: false,
      reason: "not_member",
      member: false,
      appEntitled: true,
    });
  });

  it("denies app admission when the app entitlement is missing or disabled", () => {
    expect(getOrganizationAppAdmission(makeOrganization(), "synapse")).toEqual({
      allowed: false,
      reason: "app_not_entitled",
      member: true,
      appEntitled: false,
    });

    expect(
      getOrganizationAppAdmission(
        makeOrganization({
          appEntitlements: [{ appKey: "synapse", enabled: false }],
        }),
        "synapse",
      ),
    ).toEqual({
      allowed: false,
      reason: "app_not_entitled",
      member: true,
      appEntitled: false,
    });
  });

  it("allows feature admission only when membership, app entitlement, and feature entitlement all pass", () => {
    const admission = getOrganizationFeatureAdmission(
      makeOrganization({
        role: "ADMIN",
        isMember: true,
        appEntitlements: [{ appKey: "thoughts", enabled: true }],
        featureEntitlements: [
          { appKey: "thoughts", featureKey: "projects", enabled: true },
        ],
      }),
      "thoughts",
      "projects",
    );

    expect(admission).toEqual({
      allowed: true,
      reason: null,
      member: true,
      appEntitled: true,
      featureEntitled: true,
    });
  });

  it("denies feature admission when app access fails even if a feature row exists", () => {
    const admission = getOrganizationFeatureAdmission(
      makeOrganization({
        appEntitlements: [{ appKey: "thoughts", enabled: false }],
        featureEntitlements: [
          { appKey: "thoughts", featureKey: "projects", enabled: true },
        ],
      }),
      "thoughts",
      "projects",
    );

    expect(admission).toEqual({
      allowed: false,
      reason: "app_not_entitled",
      member: true,
      appEntitled: false,
      featureEntitled: true,
    });
  });

  it("denies feature admission when the feature entitlement is missing or disabled", () => {
    expect(
      getOrganizationFeatureAdmission(
        makeOrganization({
          appEntitlements: [{ appKey: "thoughts", enabled: true }],
        }),
        "thoughts",
        "projects",
      ),
    ).toEqual({
      allowed: false,
      reason: "feature_not_entitled",
      member: true,
      appEntitled: true,
      featureEntitled: false,
    });

    expect(
      getOrganizationFeatureAdmission(
        makeOrganization({
          appEntitlements: [{ appKey: "thoughts", enabled: true }],
          featureEntitlements: [
            { appKey: "thoughts", featureKey: "projects", enabled: false },
          ],
        }),
        "thoughts",
        "projects",
      ),
    ).toEqual({
      allowed: false,
      reason: "feature_not_entitled",
      member: true,
      appEntitled: true,
      featureEntitled: false,
    });
  });

  it("filters organizations down to the ones admitted for a specific app", () => {
    const organizations = [
      makeOrganization({
        id: "org-1",
        slug: "cortex",
        appEntitlements: [{ appKey: "synapse", enabled: true }],
      }),
      makeOrganization({
        id: "org-2",
        slug: "dbest",
        appEntitlements: [{ appKey: "synapse", enabled: false }],
      }),
      makeOrganization({
        id: "org-3",
        slug: "shared",
        role: "SUPERADMIN",
        isMember: false,
        appEntitlements: [{ appKey: "synapse", enabled: true }],
      }),
    ];

    expect(listOrganizationsWithAppAccess(organizations, "synapse")).toEqual([
      organizations[0],
    ]);
  });
});

