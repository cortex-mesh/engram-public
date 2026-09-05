import type { AppAccessMode } from "@/lib/app-access";
import type { AppKey } from "@/lib/authorization";
import { isPlatformSuperadmin } from "@/lib/authorization";
import { PLATFORM_APPS } from "@/lib/apps";
import { prisma } from "@/lib/prisma";

interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
  appEntitlements: Array<{ appKey: AppKey | string; enabled: boolean }>;
  featureEntitlements: Array<{ appKey: AppKey | string; featureKey: string; enabled: boolean }>;
  members: Array<{ userId: string; user?: { role: string | null } }>;
}

interface OrganizationMemberRecord {
  role: string;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    username: string;
    displayName: string | null;
    role: string;
  };
}

interface OrganizationDetailRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
  appEntitlements: Array<{ appKey: AppKey | string; enabled: boolean; accessMode: AppAccessMode | string }>;
  featureEntitlements: Array<{ appKey: AppKey | string; featureKey: string; enabled: boolean }>;
  members: OrganizationMemberRecord[];
}

interface UserRecord {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  role: string;
  createdAt?: Date;
  orgMembers?: Array<{
    role: string;
    org: {
      id: string;
      name: string;
      slug: string;
    };
  }>;
}

export interface AdminOverviewStats {
  clientCount: number;
  userCount: number;
  membershipCount: number;
  enabledAppCount: number;
  enabledFeatureCount: number;
}

export interface AdminClientListItem {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  enabledApps: string[];
  enabledFeatures: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminOverview {
  stats: AdminOverviewStats;
  recentClients: AdminClientListItem[];
}

export interface AdminClientMember {
  id: string;
  email: string;
  username: string;
  displayName: string;
  platformRole: string;
  orgRole: string;
  joinedAt: string;
}

export interface AdminClientApp {
  key: AppKey;
  name: string;
  description: string;
  enabled: boolean;
  accessMode: AppAccessMode;
}

export interface AdminClientFeature {
  appKey: AppKey;
  appName: string;
  featureKey: string;
  featureName: string;
  description: string;
  appEnabled: boolean;
  enabled: boolean;
}

export interface AdminClientDetail {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  members: AdminClientMember[];
  apps: AdminClientApp[];
  features: AdminClientFeature[];
}

export interface AdminUserSummary {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: string;
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
  }>;
}

export interface AdminAppSummary {
  key: AppKey;
  name: string;
  description: string;
  icon: string;
  enabledClientCount: number;
  featureCount: number;
}

export interface AdminFeatureSummary {
  appKey: AppKey;
  appName: string;
  featureKey: string;
  featureName: string;
  description: string;
  enabledClientCount: number;
}

export interface AdminWaitlistRequest {
  id: string;
  email: string;
  displayName: string | null;
  clientId: string | null;
  collectionSizeBracket: string | null;
  formatsPlayed: string[];
  tradepostGoals: string[];
  priorityNote: string | null;
  requestCount: number;
  lastRequestedAt: string;
  emailHygieneStatus: string;
  emailHygieneReason: string | null;
  confirmationEmailSuppressedAt: string | null;
  suppression: {
    reason: string;
    eventType: string | null;
    updatedAt: string;
  } | null;
  approvedAt: string | null;
  hiddenAt: string | null;
  hiddenByUserId: string | null;
  hiddenReason: string | null;
  createdAt: string;
}

export type AdminWaitlistVisibility = "visible" | "hidden" | "all";

export interface AdminWaitlistPage {
  requests: AdminWaitlistRequest[];
  nextCursor: string | null;
  visibility: AdminWaitlistVisibility;
  pageSize: number;
}

const ADMIN_WAITLIST_PAGE_SIZE = 200;

const ORG_ROLE_ORDER = new Map<string, number>([
  ["OWNER", 0],
  ["ADMIN", 1],
  ["MEMBER", 2],
]);

function sortMembers(left: OrganizationMemberRecord, right: OrganizationMemberRecord) {
  const leftOrder = ORG_ROLE_ORDER.get(left.role) ?? 99;
  const rightOrder = ORG_ROLE_ORDER.get(right.role) ?? 99;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return left.createdAt.getTime() - right.createdAt.getTime();
}

function isAppEnabled(
  org: Pick<OrganizationRecord | OrganizationDetailRecord, "appEntitlements">,
  appKey: AppKey,
): boolean {
  return org.appEntitlements.some(
    (entitlement) => entitlement.appKey === appKey && entitlement.enabled,
  );
}

function isFeatureEnabled(
  org: Pick<OrganizationRecord | OrganizationDetailRecord, "appEntitlements" | "featureEntitlements">,
  appKey: AppKey,
  featureKey: string,
): boolean {
  return (
    isAppEnabled(org, appKey) &&
    org.featureEntitlements.some(
      (entitlement) =>
        entitlement.appKey === appKey &&
        entitlement.featureKey === featureKey &&
        entitlement.enabled,
    )
  );
}

function toVisibleMembers<T extends { user: { role: string | null | undefined } }>(members: T[]): T[] {
  return members.filter((member) => !isPlatformSuperadmin(member.user.role));
}

function countVisibleMembers(
  org: Pick<OrganizationRecord, "members"> | Pick<OrganizationDetailRecord, "members">,
): number {
  return org.members.filter((member) => !isPlatformSuperadmin(member.user?.role)).length;
}

function toVisibleUsers<T extends { role: string | null | undefined }>(users: T[]): T[] {
  return users.filter((user) => !isPlatformSuperadmin(user.role));
}

function toClientListItem(org: OrganizationRecord): AdminClientListItem {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    memberCount: countVisibleMembers(org),
    enabledApps: org.appEntitlements
      .filter((entitlement) => entitlement.enabled)
      .map((entitlement) => entitlement.appKey)
      .sort(),
    enabledFeatures: org.featureEntitlements
      .filter(
        (entitlement) =>
          entitlement.enabled && isAppEnabled(org, entitlement.appKey as AppKey),
      )
      .map((entitlement) => `${entitlement.appKey}.${entitlement.featureKey}`)
      .sort(),
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}

async function listOrganizations(): Promise<OrganizationRecord[]> {
  return (await prisma.organization.findMany({
    orderBy: [{ createdAt: "desc" }, { name: "asc" }],
    include: {
      appEntitlements: {
        orderBy: { appKey: "asc" },
        select: { appKey: true, enabled: true },
      },
      featureEntitlements: {
        orderBy: [{ appKey: "asc" }, { featureKey: "asc" }],
        select: { appKey: true, featureKey: true, enabled: true },
      },
      members: {
        select: {
          userId: true,
          user: {
            select: {
              role: true,
            },
          },
        },
      },
    },
  })) as OrganizationRecord[];
}

export async function getAdminOverview(): Promise<AdminOverview> {
  const [organizations, users] = await Promise.all([
    listOrganizations(),
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, role: true },
    }) as Promise<UserRecord[]>,
  ]);

  const recentClients = organizations.map(toClientListItem).slice(0, 5);
  const visibleUsers = toVisibleUsers(users);

  return {
    stats: {
      clientCount: organizations.length,
      userCount: visibleUsers.length,
      membershipCount: organizations.reduce((sum, org) => sum + countVisibleMembers(org), 0),
      enabledAppCount: organizations.reduce(
        (sum, org) => sum + org.appEntitlements.filter((entitlement) => entitlement.enabled).length,
        0,
      ),
      enabledFeatureCount: organizations.reduce(
        (sum, org) =>
          sum +
          org.featureEntitlements.filter(
            (entitlement) =>
              entitlement.enabled && isAppEnabled(org, entitlement.appKey as AppKey),
          ).length,
        0,
      ),
    },
    recentClients,
  };
}

export async function listAdminClients(): Promise<AdminClientListItem[]> {
  const organizations = await listOrganizations();
  return organizations.map(toClientListItem);
}

export async function getAdminClientDetail(orgId: string): Promise<AdminClientDetail | null> {
  const organization = (await prisma.organization.findUnique({
    where: { id: orgId },
    include: {
      appEntitlements: {
        orderBy: { appKey: "asc" },
        select: { appKey: true, enabled: true, accessMode: true },
      },
      featureEntitlements: {
        orderBy: [{ appKey: "asc" }, { featureKey: "asc" }],
        select: { appKey: true, featureKey: true, enabled: true },
      },
      members: {
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              displayName: true,
              role: true,
            },
          },
        },
      },
    },
  })) as OrganizationDetailRecord | null;

  if (!organization) {
    return null;
  }

  const members = toVisibleMembers([...organization.members])
    .sort(sortMembers)
    .map((member) => ({
      id: member.user.id,
      email: member.user.email,
      username: member.user.username,
      displayName: member.user.displayName || member.user.username,
      platformRole: member.user.role,
      orgRole: member.role,
      joinedAt: member.createdAt.toISOString(),
    }));

  const appState = new Map(
    organization.appEntitlements.map((entitlement) => [
      entitlement.appKey,
      { enabled: entitlement.enabled, accessMode: entitlement.accessMode },
    ]),
  );
  const apps: AdminClientApp[] = PLATFORM_APPS.map((app) => ({
    key: app.key,
    name: app.name,
    description: app.description,
    enabled: appState.get(app.key)?.enabled || false,
    accessMode: (appState.get(app.key)?.accessMode as AppAccessMode) || "ALL_MEMBERS",
  }));

  const features: AdminClientFeature[] = PLATFORM_APPS.flatMap((app) =>
    app.features.map((feature) => ({
      appKey: app.key,
      appName: app.name,
      featureKey: feature.key,
      featureName: feature.name,
      description: feature.description,
      appEnabled: isAppEnabled(organization, app.key),
      enabled: isFeatureEnabled(organization, app.key, feature.key),
    })),
  ).sort((left, right) => {
    if (left.appName !== right.appName) {
      return left.appName.localeCompare(right.appName);
    }
    return left.featureName.localeCompare(right.featureName);
  });

  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
    members,
    apps,
    features,
  };
}

export async function listAdminUsers(): Promise<AdminUserSummary[]> {
  const users = (await prisma.user.findMany({
    orderBy: [{ createdAt: "desc" }, { email: "asc" }],
    include: {
      orgMembers: {
        include: {
          org: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      },
    },
  })) as UserRecord[];

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    organizations: (isPlatformSuperadmin(user.role) ? [] : user.orgMembers || [])
      .map((membership) => ({
        id: membership.org.id,
        name: membership.org.name,
        slug: membership.org.slug,
        role: membership.role,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }));
}

function waitlistVisibilityWhere(visibility: AdminWaitlistVisibility) {
  if (visibility === "visible") return { hiddenAt: null };
  if (visibility === "hidden") return { hiddenAt: { not: null } };
  return {};
}

function normalizeWaitlistVisibility(value: string | null | undefined): AdminWaitlistVisibility {
  return value === "hidden" || value === "all" ? value : "visible";
}

function toAdminWaitlistRequest(request: {
  id: string;
  email: string;
  displayName: string | null;
  clientId: string | null;
  collectionSizeBracket: string | null;
  formatsPlayed: string[];
  tradepostGoals: string[];
  priorityNote: string | null;
  requestCount: number;
  lastRequestedAt: Date;
  emailHygieneStatus: string;
  emailHygieneReason: string | null;
  confirmationEmailSuppressedAt: Date | null;
  suppression: {
    reason: string;
    eventType: string | null;
    updatedAt: Date;
  } | null;
  approvedAt: Date | null;
  hiddenAt: Date | null;
  hiddenByUserId: string | null;
  hiddenReason: string | null;
  createdAt: Date;
}): AdminWaitlistRequest {
  return {
    id: request.id,
    email: request.email,
    displayName: request.displayName,
    clientId: request.clientId,
    collectionSizeBracket: request.collectionSizeBracket,
    formatsPlayed: request.formatsPlayed,
    tradepostGoals: request.tradepostGoals,
    priorityNote: request.priorityNote,
    requestCount: request.requestCount,
    lastRequestedAt: request.lastRequestedAt.toISOString(),
    emailHygieneStatus: request.emailHygieneStatus,
    emailHygieneReason: request.emailHygieneReason,
    confirmationEmailSuppressedAt: request.confirmationEmailSuppressedAt?.toISOString() ?? null,
    suppression: request.suppression
      ? {
          reason: request.suppression.reason,
          eventType: request.suppression.eventType,
          updatedAt: request.suppression.updatedAt.toISOString(),
        }
      : null,
    approvedAt: request.approvedAt?.toISOString() ?? null,
    hiddenAt: request.hiddenAt?.toISOString() ?? null,
    hiddenByUserId: request.hiddenByUserId,
    hiddenReason: request.hiddenReason,
    createdAt: request.createdAt.toISOString(),
  };
}

export async function listAdminWaitlistRequestPage(options: {
  visibility?: string | null;
  cursor?: string | null;
  pageSize?: number;
} = {}): Promise<AdminWaitlistPage> {
  const visibility = normalizeWaitlistVisibility(options.visibility);
  const pageSize = Math.min(Math.max(Number(options.pageSize ?? ADMIN_WAITLIST_PAGE_SIZE), 1), ADMIN_WAITLIST_PAGE_SIZE);
  const requests = await prisma.waitlistRequest.findMany({
    where: waitlistVisibilityWhere(visibility),
    orderBy: [
      { approvedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    take: pageSize + 1,
    select: {
      id: true,
      email: true,
      displayName: true,
      clientId: true,
      collectionSizeBracket: true,
      formatsPlayed: true,
      tradepostGoals: true,
      priorityNote: true,
      requestCount: true,
      lastRequestedAt: true,
      emailHygieneStatus: true,
      emailHygieneReason: true,
      confirmationEmailSuppressedAt: true,
      approvedAt: true,
      hiddenAt: true,
      hiddenByUserId: true,
      hiddenReason: true,
      createdAt: true,
    },
  });
  const emails = requests.map((request) => request.email);
  const suppressions = await prisma.emailSuppression.findMany({
    where: { email: { in: emails } },
    select: {
      email: true,
      reason: true,
      eventType: true,
      updatedAt: true,
    },
  });
  const suppressionByEmail = new Map(suppressions.map((suppression) => [suppression.email, suppression]));

  const pageRows = requests.slice(0, pageSize);
  return {
    requests: pageRows.map((request) =>
      toAdminWaitlistRequest({
        ...request,
        suppression: suppressionByEmail.get(request.email) ?? null,
      }),
    ),
    nextCursor: requests.length > pageSize ? (pageRows.at(-1)?.id ?? null) : null,
    visibility,
    pageSize,
  };
}

export async function listAdminWaitlistRequests(): Promise<AdminWaitlistRequest[]> {
  return (await listAdminWaitlistRequestPage()).requests;
}

export async function listAdminApps(): Promise<AdminAppSummary[]> {
  const organizations = await listOrganizations();

  return PLATFORM_APPS.map((app) => ({
    key: app.key,
    name: app.name,
    description: app.description,
    icon: app.icon,
    enabledClientCount: organizations.filter((org) =>
      org.appEntitlements.some((entitlement) => entitlement.appKey === app.key && entitlement.enabled),
    ).length,
    featureCount: app.features.length,
  }));
}

export async function listAdminFeatures(): Promise<AdminFeatureSummary[]> {
  const organizations = await listOrganizations();

  return PLATFORM_APPS.flatMap((app) =>
    app.features.map((feature) => ({
      appKey: app.key,
      appName: app.name,
      featureKey: feature.key,
      featureName: feature.name,
      description: feature.description,
      enabledClientCount: organizations.filter((org) =>
        isFeatureEnabled(org, app.key, feature.key),
      ).length,
    })),
  ).sort((left, right) => {
    if (left.appName !== right.appName) {
      return left.appName.localeCompare(right.appName);
    }
    return left.featureName.localeCompare(right.featureName);
  });
}
