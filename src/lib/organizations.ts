import { isOrgManager } from "@/lib/authorization";
import { getAllowedPublicOrigins } from "@/lib/public-origin";
import { computeAppAccess, type AppAccessEntry, type AppAccessMode } from "@/lib/app-access";

export interface OrganizationAppEntitlementSummary {
  appKey: string;
  enabled: boolean;
}

export interface OrganizationFeatureEntitlementSummary {
  appKey: string;
  featureKey: string;
  enabled: boolean;
}

export interface OrganizationUserAppOverrideSummary {
  appKey: string;
  enabled: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  isMember: boolean;
  appEntitlements: OrganizationAppEntitlementSummary[];
  featureEntitlements: OrganizationFeatureEntitlementSummary[];
  userAppOverrides: OrganizationUserAppOverrideSummary[];
  appAccess: AppAccessEntry[];
  memberCount: number;
  pendingInviteCount: number;
  latestActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ORG_NAME_MIN_LENGTH = 2;
const ORG_NAME_MAX_LENGTH = 80;
const ORG_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const RESERVED_ORG_SLUGS: readonly string[] = [
  "login",
  "platform",
  "plexus",
  "api",
];

export { isOrgManager };

export function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export function isForeignKeyConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2003"
  );
}

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function getTrustedPublicOrigins(): string[] {
  const configuredOrigins = [
    ...getAllowedPublicOrigins(),
    ...(process.env.ENGRAM_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];

  return Array.from(
    new Set(configuredOrigins.map((value) => normalizeOrigin(value)).filter((value): value is string => !!value)),
  );
}

/**
 * Returns the base domain that all tenant origins share, derived from
 * ENGRAM_URL by stripping the leading host segment (e.g.
 * "https://login.dev.ctxhost.com" → "dev.ctxhost.com"). Returns null when
 * ENGRAM_URL is unset, malformed, or has no parent domain (single-label host).
 */
export function getTenantBaseDomain(): string | null {
  const engramUrl = process.env.ENGRAM_URL;
  if (!engramUrl) return null;
  try {
    const hostname = new URL(engramUrl).hostname;
    const dot = hostname.indexOf(".");
    if (dot === -1) return null;
    return hostname.slice(dot + 1);
  } catch {
    return null;
  }
}

/**
 * Returns true when `origin` should be allowed to make credentialed
 * cross-origin reads against Engram. Two trust paths:
 *
 *   1. Explicit list — ENGRAM_URL + ENGRAM_ALLOWED_ORIGINS (static, env-driven).
 *   2. Tenant subdomain — any `<slug>.<baseDomain>` where baseDomain is derived
 *      from ENGRAM_URL (e.g. "dev.ctxhost.com"). This makes every new tenant org
 *      trusted automatically without a config change.
 *
 * Only applies to read (GET/OPTIONS) endpoints via credentialedReadCorsHeaders.
 * Mutation routes are protected separately by hasCrossOriginCookieWrite.
 */
export function isTrustedPublicOrigin(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  if (getTrustedPublicOrigins().includes(normalized)) return true;

  const baseDomain = getTenantBaseDomain();
  if (!baseDomain) return false;

  try {
    const engramUrl = process.env.ENGRAM_URL!;
    const engramProtocol = new URL(engramUrl).protocol;
    const originUrl = new URL(normalized);
    return (
      originUrl.protocol === engramProtocol &&
      originUrl.hostname !== baseDomain &&
      originUrl.hostname.endsWith("." + baseDomain)
    );
  } catch {
    return false;
  }
}

export function hasCrossOriginCookieWrite(request: Request) {
  const cookieHeader = request.headers.get("cookie");

  // No ambient cookie credential → not a CSRF vector. Bearer/internal-key
  // callers (native apps, services) can't be driven cross-site because an
  // attacker page can't set those headers without a CORS preflight, so they
  // pass through here.
  if (!cookieHeader) {
    return false;
  }

  const origin = normalizeOrigin(request.headers.get("origin"));

  if (!origin) {
    // Cookie present but no Origin header. Modern browsers still send
    // Sec-Fetch-Site on state-changing requests; allow only same-origin or
    // a direct navigation. Anything else — including both signals being
    // absent — FAILS CLOSED: a cookie-authenticated write must prove its
    // origin (security audit 2026-06-10, #1 + #15).
    const secFetchSite = request.headers.get("sec-fetch-site");
    return !(secFetchSite === "same-origin" || secFetchSite === "none");
  }

  const host = request.headers.get("host");
  const requestOrigin = host
    ? normalizeOrigin(`${new URL(request.url).protocol}//${host}`)
    : normalizeOrigin(request.url);

  if (requestOrigin === origin) {
    return false;
  }

  return !getTrustedPublicOrigins().includes(origin);
}

export function validateOrganizationInput(input: {
  name?: unknown;
  slug?: unknown;
  partial?: boolean;
}) {
  const { partial = false } = input;
  const name = typeof input.name === "string" ? input.name.trim() : undefined;
  const slug = typeof input.slug === "string" ? input.slug.trim() : undefined;

  if (!partial && (!name || !slug)) {
    return {
      error:
        "Organization name must be between 2 and 80 characters and slug must contain only lowercase letters, numbers, and hyphens.",
    };
  }

  if (
    (name !== undefined &&
      (name.length < ORG_NAME_MIN_LENGTH || name.length > ORG_NAME_MAX_LENGTH)) ||
    (slug !== undefined && !ORG_SLUG_REGEX.test(slug))
  ) {
    return {
      error:
        "Organization name must be between 2 and 80 characters and slug must contain only lowercase letters, numbers, and hyphens.",
    };
  }

  if (slug !== undefined && RESERVED_ORG_SLUGS.includes(slug)) {
    return {
      error: `Organization slug "${slug}" is reserved.`,
    };
  }

  const data: { name?: string; slug?: string } = {};
  if (name !== undefined) data.name = name;
  if (slug !== undefined) data.slug = slug;

  if (partial && Object.keys(data).length === 0) {
    return { error: "Provide at least one organization field to update." };
  }

  return { data };
}

export function toOrganizationSummary(org: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
  _count: { members: number; invites?: number };
  members?: Array<{ role: string; createdAt?: Date }>;
  invites?: Array<{ createdAt: Date; updatedAt?: Date; acceptedAt: Date | null; revokedAt: Date | null }>;
  appEntitlements?: Array<{ appKey: string; enabled: boolean; accessMode?: string; updatedAt?: Date }>;
  featureEntitlements?: Array<{ appKey: string; featureKey: string; enabled: boolean; updatedAt?: Date }>;
  userAppOverrides?: Array<{ appKey: string; enabled: boolean }>;
  roleOverride?: string;
  isMemberOverride?: boolean;
  // Pass "SUPERADMIN" only once the CALLER's current platform role has been
  // freshly re-read from the DB (audit #9) — never the JWT claim, which can
  // be stale for up to 15 minutes after a demotion. Omit/null otherwise.
  platformRole?: string | null;
}) : OrganizationSummary {
  const orgRole = org.roleOverride || org.members?.[0]?.role || "MEMBER";

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: orgRole,
    isMember: org.isMemberOverride ?? (org.members?.length ?? 0) > 0,
    appEntitlements: org.appEntitlements?.map((entitlement) => ({
      appKey: entitlement.appKey,
      enabled: entitlement.enabled,
    })) || [],
    featureEntitlements: org.featureEntitlements?.map((entitlement) => ({
      appKey: entitlement.appKey,
      featureKey: entitlement.featureKey,
      enabled: entitlement.enabled,
    })) || [],
    userAppOverrides: org.userAppOverrides?.map((override) => ({
      appKey: override.appKey,
      enabled: override.enabled,
    })) || [],
    appAccess: computeAppAccess({
      platformRole: org.platformRole,
      orgRole,
      appEntitlements: (org.appEntitlements || []).map((entitlement) => ({
        appKey: entitlement.appKey,
        enabled: entitlement.enabled,
        accessMode: (entitlement.accessMode as AppAccessMode | undefined) || "ALL_MEMBERS",
      })),
      userAppOverrides: org.userAppOverrides || [],
    }),
    memberCount: org._count.members,
    pendingInviteCount:
      org.invites
        ? org.invites.filter((invite) => !invite.acceptedAt && !invite.revokedAt).length
        : (org._count.invites ?? 0),
    latestActivityAt: getLatestActivityAt(org),
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}

function getLatestActivityAt(org: {
  updatedAt: Date;
  members?: Array<{ createdAt?: Date }>;
  invites?: Array<{ createdAt: Date; updatedAt?: Date; acceptedAt: Date | null; revokedAt: Date | null }>;
  appEntitlements?: Array<{ updatedAt?: Date }>;
  featureEntitlements?: Array<{ updatedAt?: Date }>;
}): string | null {
  const timestamps = [org.updatedAt.getTime()];

  for (const member of org.members || []) {
    if (member.createdAt) timestamps.push(member.createdAt.getTime());
  }
  for (const invite of org.invites || []) {
    if (invite.updatedAt) timestamps.push(invite.updatedAt.getTime());
    else timestamps.push(invite.createdAt.getTime());
  }
  for (const entitlement of org.appEntitlements || []) {
    if (entitlement.updatedAt) timestamps.push(entitlement.updatedAt.getTime());
  }
  for (const entitlement of org.featureEntitlements || []) {
    if (entitlement.updatedAt) timestamps.push(entitlement.updatedAt.getTime());
  }

  const latest = Math.max(...timestamps);
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}
