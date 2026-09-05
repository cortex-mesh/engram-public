export const PLATFORM_SUPERADMIN = "SUPERADMIN" as const;

export const ORG_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const APP_KEYS = [
  "dashboard",
  "synapse",
  "thoughts",
  "axon",
  "pulse",
  "gyrus",
  "tradepost",
  "fieldops",
] as const;
export type AppKey = (typeof APP_KEYS)[number];

const APP_FEATURES = {
  dashboard: [] as const,
  synapse: [] as const,
  thoughts: ["projects", "adr"] as const,
  axon: [] as const,
  pulse: [] as const,
  gyrus: [] as const,
  tradepost: [] as const,
  fieldops: [] as const,
} satisfies Record<AppKey, readonly string[]>;

export function isPlatformSuperadmin(role: string | null | undefined): boolean {
  return role === PLATFORM_SUPERADMIN;
}

export function isOrgOwner(role: string | null | undefined): boolean {
  return role === "OWNER";
}

export function isOrgManager(role: string | null | undefined): boolean {
  return isOrgOwner(role) || role === "ADMIN";
}

export function isAppKey(value: string | null | undefined): value is AppKey {
  return !!value && APP_KEYS.includes(value as AppKey);
}

export function isFeatureKey(
  appKey: string | null | undefined,
  featureKey: string | null | undefined,
): boolean {
  if (!isAppKey(appKey) || !featureKey) {
    return false;
  }

  return APP_FEATURES[appKey].some((allowedFeature) => allowedFeature === featureKey);
}
