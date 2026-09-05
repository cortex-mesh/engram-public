import { describe, expect, it } from "vitest";

import { canAccessApp } from "@/lib/app-access";

const ALL_MEMBERS = { enabled: true, accessMode: "ALL_MEMBERS" as const };
const RESTRICTED = { enabled: true, accessMode: "RESTRICTED" as const };
const DISABLED_ALL_MEMBERS = { enabled: false, accessMode: "ALL_MEMBERS" as const };
const DISABLED_RESTRICTED = { enabled: false, accessMode: "RESTRICTED" as const };

const PLATFORM_ROLES = ["SUPERADMIN", "ADMIN", "USER"] as const;
const ORG_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
const OVERRIDES = {
  allow: { enabled: true },
  deny: { enabled: false },
  absent: undefined,
} as const;

describe("canAccessApp", () => {
  it("SUPERADMIN always passes, regardless of entitlement/override state", () => {
    for (const entitlement of [ALL_MEMBERS, RESTRICTED, DISABLED_ALL_MEMBERS, DISABLED_RESTRICTED, null, undefined]) {
      for (const orgRole of [...ORG_ROLES, null, undefined]) {
        for (const overrideKey of Object.keys(OVERRIDES) as Array<keyof typeof OVERRIDES>) {
          expect(
            canAccessApp({
              platformRole: "SUPERADMIN",
              orgRole,
              entitlement,
              userOverride: OVERRIDES[overrideKey],
            }),
          ).toBe(true);
        }
      }
    }
  });

  it("denies when the entitlement is missing (app not entitled to the org)", () => {
    for (const platformRole of ["ADMIN", "USER", null, undefined]) {
      for (const orgRole of ORG_ROLES) {
        for (const overrideKey of Object.keys(OVERRIDES) as Array<keyof typeof OVERRIDES>) {
          expect(
            canAccessApp({
              platformRole,
              orgRole,
              entitlement: null,
              userOverride: OVERRIDES[overrideKey],
            }),
          ).toBe(false);
        }
      }
    }
  });

  it("denies when the entitlement is disabled, for both access modes", () => {
    for (const entitlement of [DISABLED_ALL_MEMBERS, DISABLED_RESTRICTED]) {
      for (const platformRole of ["ADMIN", "USER"]) {
        for (const orgRole of ORG_ROLES) {
          for (const overrideKey of Object.keys(OVERRIDES) as Array<keyof typeof OVERRIDES>) {
            expect(
              canAccessApp({
                platformRole,
                orgRole,
                entitlement,
                userOverride: OVERRIDES[overrideKey],
              }),
            ).toBe(false);
          }
        }
      }
    }
  });

  describe("ALL_MEMBERS mode (non-superadmin)", () => {
    it.each([
      ["OWNER", "allow", true],
      ["OWNER", "absent", true],
      ["OWNER", "deny", false],
      ["ADMIN", "allow", true],
      ["ADMIN", "absent", true],
      ["ADMIN", "deny", false],
      ["MEMBER", "allow", true],
      ["MEMBER", "absent", true],
      ["MEMBER", "deny", false],
    ] as const)("orgRole=%s override=%s -> %s", (orgRole, overrideKey, expected) => {
      for (const platformRole of ["ADMIN", "USER", null, undefined]) {
        expect(
          canAccessApp({
            platformRole,
            orgRole,
            entitlement: ALL_MEMBERS,
            userOverride: OVERRIDES[overrideKey],
          }),
        ).toBe(expected);
      }
    });
  });

  describe("RESTRICTED mode (non-superadmin)", () => {
    it.each([
      ["OWNER", "allow", true],
      ["OWNER", "absent", true],
      ["OWNER", "deny", true],
      ["ADMIN", "allow", true],
      ["ADMIN", "absent", true],
      ["ADMIN", "deny", true],
      ["MEMBER", "allow", true],
      ["MEMBER", "absent", false],
      ["MEMBER", "deny", false],
    ] as const)("orgRole=%s override=%s -> %s", (orgRole, overrideKey, expected) => {
      for (const platformRole of ["ADMIN", "USER", null, undefined]) {
        expect(
          canAccessApp({
            platformRole,
            orgRole,
            entitlement: RESTRICTED,
            userOverride: OVERRIDES[overrideKey],
          }),
        ).toBe(expected);
      }
    });
  });

  it("exhaustively covers accessMode x platformRole x orgRole x override", () => {
    const modes = ["ALL_MEMBERS", "RESTRICTED"] as const;

    for (const accessMode of modes) {
      for (const platformRole of PLATFORM_ROLES) {
        for (const orgRole of ORG_ROLES) {
          for (const overrideKey of Object.keys(OVERRIDES) as Array<keyof typeof OVERRIDES>) {
            const userOverride = OVERRIDES[overrideKey];
            const result = canAccessApp({
              platformRole,
              orgRole,
              entitlement: { enabled: true, accessMode },
              userOverride,
            });

            let expected: boolean;
            if (platformRole === "SUPERADMIN") {
              expected = true;
            } else if (accessMode === "ALL_MEMBERS") {
              expected = userOverride?.enabled !== false;
            } else {
              expected = orgRole === "OWNER" || orgRole === "ADMIN" ? true : userOverride?.enabled === true;
            }

            expect(result).toBe(expected);
          }
        }
      }
    }
  });
});
