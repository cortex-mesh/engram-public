import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import {
  APP_KEYS,
  isPlatformSuperadmin,
  type AppKey,
} from "@/lib/authorization";
import {
  PLATFORM_APPS,
  buildTenantWorkspaceUrl,
  getFeatureUrl,
  getOptionalAppUrl,
  type PlatformAppDefinition,
} from "@/lib/apps";
import { credentialedReadCorsHeaders, preflightResponse } from "@/lib/cors";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/me/app-switcher?org=<orgId>
 *
 * Returns the current user, their orgs, the active org context, and the
 * list of apps they can see in the cross-app switcher (cortex ADR-102 §D4).
 *
 * Effective entitlement per org (extending Engram ADR-005 + ADR-009):
 *
 *   user is SUPERADMIN  → every catalog app
 *   user is org member  → OrgAppEntitlement.enabled === true
 *                         AND NOT (UserAppEntitlement.enabled === false)
 *
 * Refusals:
 *   401 — no Engram session
 *   403 — internal API key auth (this is a user-facing endpoint)
 *   403 — `?org=` for an org the caller can't see
 *
 * CORS: credentialed cross-origin reads are allowed for any origin in
 * ENGRAM_ALLOWED_ORIGINS (or ENGRAM_URL). The hosted tenant apps
 * (<org>.dev.ctxhost.com/<app>, etc.) live on different origins than
 * login.dev.ctxhost.com and call this endpoint with `credentials: include`.
 */
export async function OPTIONS(request: NextRequest) {
  return preflightResponse(request);
}

export async function GET(request: NextRequest) {
  const cors = credentialedReadCorsHeaders(request);

  const auth = await authenticateRequest(request);
  if (!auth) {
    return json({ error: "Unauthorized" }, 401, cors);
  }
  if (auth.userId === "internal") {
    return json(
      { error: "Internal API key auth is not allowed for the app switcher." },
      403,
      cors,
    );
  }

  const requestedOrgId = request.nextUrl.searchParams.get("org");

  try {
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        role: true,
        lastOrgId: true,
      },
    });
    if (!user) {
      return json({ error: "Unauthorized" }, 401, cors);
    }

    // SUPERADMIN status from the freshly-read DB role, not the JWT claim, so a
    // demoted superadmin loses the elevated switcher view immediately (audit
    // #9). No extra query — the user row is already fetched above.
    const superadmin = isPlatformSuperadmin(user.role);

    const memberships = await prisma.orgMember.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "asc" },
      include: {
        org: { select: { id: true, slug: true, name: true } },
      },
    });

    const memberOrgs = memberships.map((m) => ({
      id: m.org.id,
      slug: m.org.slug,
      displayName: m.org.name,
    }));

    let activeOrg: { id: string; slug: string; displayName: string } | null =
      null;
    let hostDerivedOrgId: string | null = null;

    if (requestedOrgId) {
      const memberMatch = memberOrgs.find((o) => o.id === requestedOrgId);
      if (memberMatch) {
        activeOrg = memberMatch;
      } else if (superadmin) {
        const org = await prisma.organization.findUnique({
          where: { id: requestedOrgId },
          select: { id: true, slug: true, name: true },
        });
        if (!org) {
          return json({ error: "Organization not found" }, 404, cors);
        }
        activeOrg = { id: org.id, slug: org.slug, displayName: org.name };
      } else {
        return json(
          { error: "You are not a member of that organization." },
          403,
          cors,
        );
      }
    } else if (memberOrgs.length > 0) {
      // Host-based tenancy: the org IS the host. When the switcher is fetched
      // from a tenant host (<slug>.dev.ctxhost.com) with no explicit ?org=,
      // default the active org to the one matching that host's subdomain so the
      // header reflects the org the user is actually looking at — not just the
      // oldest membership. Falls back to memberOrgs[0] off-tenant (login/platform).
      const originSlug = orgSlugFromRequestOrigin(request);
      const hostMatch = originSlug
        ? memberOrgs.find((o) => o.slug === originSlug)
        : undefined;
      activeOrg = hostMatch ?? memberOrgs[0];
      // Track host-derived visits so post-login routing can return users to
      // their most-recently-used org. Only the host-match path (not the
      // memberOrgs[0] fallback when off-tenant) qualifies as "active on this org".
      if (hostMatch) {
        hostDerivedOrgId = hostMatch.id;
      }
    }

    // Best-effort: record most-recently-used org when the user is on its host
    // and it differs from what's already stored. Fire-and-forget — a transient
    // DB error must never fail a read-only switcher fetch.
    if (hostDerivedOrgId && hostDerivedOrgId !== user.lastOrgId) {
      void prisma.user.update({
        where: { id: auth.userId },
        data: { lastOrgId: hostDerivedOrgId },
      }).catch(() => { /* best-effort */ });
    }

    const apps = activeOrg
      ? await resolveEntitledApps({
          orgId: activeOrg.id,
          orgSlug: activeOrg.slug,
          userId: auth.userId,
          superadmin,
        })
      : [];

    return json(
      {
        user: {
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          avatarUrl: user.avatarUrl,
          role: user.role,
        },
        org: activeOrg,
        orgs: memberOrgs,
        apps,
      },
      200,
      cors,
    );
  } catch (err) {
    console.error("app-switcher endpoint error:", err);
    return json({ error: "Failed to resolve app switcher." }, 500, cors);
  }
}

function json(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string>,
): NextResponse {
  return NextResponse.json(body, { status, headers: extraHeaders });
}

// Non-tenant suite hosts whose leading label is NOT an org slug.
const NON_TENANT_LABELS = new Set(["login", "platform", "www", "localhost"]);

/**
 * The active org is host-derived (host-based tenancy): a switcher fetch from
 * `<slug>.dev.ctxhost.com` carries that origin, so the leading DNS label names
 * the tenant. Returns null for off-tenant origins (login/platform), absent
 * origins, or unparseable values — callers then fall back to membership order.
 */
function orgSlugFromRequestOrigin(request: NextRequest): string | null {
  const origin =
    request.headers.get("origin") || request.headers.get("referer");
  if (!origin) return null;
  try {
    const label = new URL(origin).hostname.split(".")[0]?.toLowerCase();
    if (!label || NON_TENANT_LABELS.has(label)) return null;
    return label;
  } catch {
    return null;
  }
}

/**
 * Re-home a catalog app/feature URL onto the active org's tenant host:
 * `https://<slug>.dev.ctxhost.com<path>` (path taken from the catalog URL).
 * Without this, product apps/features used catalog URLs whose default host is
 * hardcoded to cortex, so switching apps always dropped the user back onto the
 * cortex tenant. Nexus (the `dashboard` key) is handled separately and already
 * org-aware via `buildTenantWorkspaceUrl`.
 */
function toOrgUrl(
  orgSlug: string,
  catalogUrl: string,
  fallbackPath: string,
): string {
  const tenantRoot = buildTenantWorkspaceUrl(orgSlug);
  // buildTenantWorkspaceUrl returns `/account` if the platform URL is
  // unparseable — fall back to the (non-org-aware) catalog URL in that case.
  if (!tenantRoot.startsWith("http")) return catalogUrl;
  let path: string;
  try {
    path = new URL(catalogUrl).pathname;
  } catch {
    path = fallbackPath;
  }
  if (!path || path === "/") path = fallbackPath;
  return `${tenantRoot.replace(/\/$/, "")}${path}`;
}

interface ResolveEntitledAppsOpts {
  orgId: string;
  orgSlug: string;
  userId: string;
  superadmin: boolean;
}

async function resolveEntitledApps(opts: ResolveEntitledAppsOpts) {
  const { orgId, orgSlug, userId, superadmin } = opts;

  let entitledKeys: ReadonlySet<AppKey>;
  // appKey -> set of org-enabled feature keys. Org features are default-DENY
  // (a feature needs an OrgAppFeatureEntitlement row with enabled === true),
  // mirroring `hasEnabledFeatureEntitlement` in @/lib/entitlements. SUPERADMIN
  // sees every catalog feature, consistent with seeing every catalog app.
  const enabledFeaturesByApp = new Map<AppKey, ReadonlySet<string>>();

  if (superadmin) {
    entitledKeys = new Set(APP_KEYS);
  } else {
    const [orgEntitlements, userOverrides, featureEntitlements] =
      await Promise.all([
        prisma.orgAppEntitlement.findMany({
          where: { orgId, enabled: true },
          select: { appKey: true },
        }),
        prisma.userAppEntitlement.findMany({
          where: { userId, orgId },
          select: { appKey: true, enabled: true },
        }),
        prisma.orgAppFeatureEntitlement.findMany({
          where: { orgId, enabled: true },
          select: { appKey: true, featureKey: true },
        }),
      ]);

    const denied = new Set<AppKey>(
      userOverrides
        .filter((o) => o.enabled === false)
        .map((o) => o.appKey as AppKey),
    );

    entitledKeys = new Set(
      orgEntitlements
        .map((e) => e.appKey as AppKey)
        .filter((key) => !denied.has(key)),
    );

    for (const row of featureEntitlements) {
      const key = row.appKey as AppKey;
      const set =
        (enabledFeaturesByApp.get(key) as Set<string>) ?? new Set<string>();
      set.add(row.featureKey);
      enabledFeaturesByApp.set(key, set);
    }
  }

  const featuresFor = (def: PlatformAppDefinition) => {
    const enabled = superadmin
      ? new Set(def.features.map((f) => f.key))
      : (enabledFeaturesByApp.get(def.key) ?? new Set<string>());
    return def.features
      .filter((feature) => enabled.has(feature.key))
      .map((feature) => {
        const url = getFeatureUrl(def, feature);
        return url
          ? {
              key: feature.key,
              name: feature.name,
              url: toOrgUrl(orgSlug, url, `/${def.key}`),
            }
          : null;
      })
      .filter((feature): feature is { key: string; name: string; url: string } => Boolean(feature));
  };

  return PLATFORM_APPS.filter((def) => entitledKeys.has(def.key)).flatMap((def) => {
    // The DB enum value "dashboard" is the Nexus tenant shell entry.
    // Surface it to clients as `key: "nexus"` (matches the AppHeader
    // package's APP_KEYS) and route the URL through the active org's
    // Nexus root, regardless of the operator-console URL recorded in
    // PLATFORM_APPS (that one stays as Plexus for redirect-validation
    // purposes — see `getAllowedOrigins` in auth-redirect.ts).
    if (def.key === "dashboard") {
      return {
        key: "nexus" as const,
        label: def.name,
        description: def.description,
        url: buildTenantWorkspaceUrl(orgSlug),
        icon: def.icon,
        features: featuresFor(def),
      };
    }
    const appUrl = getOptionalAppUrl(def);
    if (!appUrl) return [];
    return {
      key: def.key,
      label: def.name,
      description: def.description,
      url: toOrgUrl(orgSlug, appUrl, `/${def.key}`),
      icon: def.icon,
      features: featuresFor(def),
    };
  });
}
