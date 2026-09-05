import type { AppKey } from "@/lib/authorization";
import type { OrganizationSummary } from "@/lib/organizations";

export type OrganizationAppAdmissionReason = "not_member" | "app_not_entitled";
export type OrganizationFeatureAdmissionReason =
  | OrganizationAppAdmissionReason
  | "feature_not_entitled";

export interface OrganizationAppAdmission {
  allowed: boolean;
  reason: OrganizationAppAdmissionReason | null;
  member: boolean;
  appEntitled: boolean;
}

export interface OrganizationFeatureAdmission {
  allowed: boolean;
  reason: OrganizationFeatureAdmissionReason | null;
  member: boolean;
  appEntitled: boolean;
  featureEntitled: boolean;
}

type OrganizationForAdmission = Pick<
  OrganizationSummary,
  "role" | "isMember" | "appEntitlements" | "featureEntitlements"
>;

function hasEnabledAppEntitlement(
  organization: Pick<OrganizationSummary, "appEntitlements">,
  appKey: AppKey,
): boolean {
  return organization.appEntitlements.some(
    (entitlement) => entitlement.appKey === appKey && entitlement.enabled,
  );
}

function hasEnabledFeatureEntitlement(
  organization: Pick<OrganizationSummary, "featureEntitlements">,
  appKey: AppKey,
  featureKey: string,
): boolean {
  return organization.featureEntitlements.some(
    (entitlement) =>
      entitlement.appKey === appKey &&
      entitlement.featureKey === featureKey &&
      entitlement.enabled,
  );
}

export function getOrganizationAppAdmission(
  organization: OrganizationForAdmission,
  appKey: AppKey,
): OrganizationAppAdmission {
  const member = organization.isMember;
  const appEntitled = hasEnabledAppEntitlement(organization, appKey);

  if (!member) {
    return {
      allowed: false,
      reason: "not_member",
      member,
      appEntitled,
    };
  }

  if (!appEntitled) {
    return {
      allowed: false,
      reason: "app_not_entitled",
      member,
      appEntitled,
    };
  }

  return {
    allowed: true,
    reason: null,
    member,
    appEntitled,
  };
}

export function getOrganizationFeatureAdmission(
  organization: OrganizationForAdmission,
  appKey: AppKey,
  featureKey: string,
): OrganizationFeatureAdmission {
  const appAdmission = getOrganizationAppAdmission(organization, appKey);
  const featureEntitled = hasEnabledFeatureEntitlement(
    organization,
    appKey,
    featureKey,
  );

  if (!appAdmission.allowed) {
    return {
      ...appAdmission,
      featureEntitled,
    };
  }

  if (!featureEntitled) {
    return {
      allowed: false,
      reason: "feature_not_entitled",
      member: appAdmission.member,
      appEntitled: appAdmission.appEntitled,
      featureEntitled,
    };
  }

  return {
    allowed: true,
    reason: null,
    member: appAdmission.member,
    appEntitled: appAdmission.appEntitled,
    featureEntitled,
  };
}

export function listOrganizationsWithAppAccess(
  organizations: OrganizationSummary[],
  appKey: AppKey,
): OrganizationSummary[] {
  return organizations.filter(
    (organization) => getOrganizationAppAdmission(organization, appKey).allowed,
  );
}
