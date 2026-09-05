import { isOrgManager, isPlatformSuperadmin } from "@/lib/authorization";

export const APP_ACCESS_MODES = ["ALL_MEMBERS", "RESTRICTED"] as const;
export type AppAccessMode = (typeof APP_ACCESS_MODES)[number];

export function isAppAccessMode(value: unknown): value is AppAccessMode {
  return typeof value === "string" && (APP_ACCESS_MODES as readonly string[]).includes(value);
}

export interface AppAccessEntitlement {
  enabled: boolean;
  accessMode: AppAccessMode;
}

export interface AppAccessUserOverride {
  enabled: boolean;
}

export interface CanAccessAppInput {
  platformRole: string | null | undefined;
  orgRole: string | null | undefined;
  entitlement: AppAccessEntitlement | null | undefined;
  userOverride: AppAccessUserOverride | null | undefined;
}

/**
 * ADR-030 D3 — the single source of truth for "may this user open this app
 * in this org". Pure function; no I/O. Callers own reading the entitlement,
 * override, and roles from the DB.
 */
export function canAccessApp({
  platformRole,
  orgRole,
  entitlement,
  userOverride,
}: CanAccessAppInput): boolean {
  if (isPlatformSuperadmin(platformRole)) {
    return true;
  }

  if (!entitlement || entitlement.enabled === false) {
    return false;
  }

  if (entitlement.accessMode === "RESTRICTED") {
    if (isOrgManager(orgRole)) {
      return true;
    }
    return userOverride?.enabled === true;
  }

  // ALL_MEMBERS (default) — allowed unless explicitly denied.
  return userOverride?.enabled !== false;
}

export interface AppAccessEntry {
  appKey: string;
  canAccess: boolean;
}

/**
 * ADR-030 D4 — the caller-scoped `appAccess` field for an org summary: one
 * entry per app the org is entitled to (i.e. has an OrgAppEntitlement row),
 * each resolved through canAccessApp. Never include another user's overrides
 * — callers must pass only the caller's own userAppOverrides.
 */
export function computeAppAccess({
  platformRole,
  orgRole,
  appEntitlements,
  userAppOverrides,
}: {
  platformRole: string | null | undefined;
  orgRole: string | null | undefined;
  appEntitlements: Array<{ appKey: string; enabled: boolean; accessMode: AppAccessMode }>;
  userAppOverrides: Array<{ appKey: string; enabled: boolean }>;
}): AppAccessEntry[] {
  return appEntitlements.map((entitlement) => {
    const userOverride = userAppOverrides.find((override) => override.appKey === entitlement.appKey);
    return {
      appKey: entitlement.appKey,
      canAccess: canAccessApp({ platformRole, orgRole, entitlement, userOverride }),
    };
  });
}
