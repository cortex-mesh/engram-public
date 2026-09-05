import type { AppKey } from "@/lib/authorization";

export interface PlatformFeatureDefinition {
  key: string;
  name: string;
  description: string;
  /**
   * Destination path within the app (appended to the app's base URL) for
   * direct feature navigation in the cross-app command palette. Omit when
   * the feature has no standalone route — callers fall back to the app URL.
   */
  path?: string;
}

export type PlatformAppUrlEnvVar =
  | "NEXT_PUBLIC_DASHBOARD_URL"
  | "NEXT_PUBLIC_SYNAPSE_URL"
  | "NEXT_PUBLIC_THOUGHTS_URL"
  | "NEXT_PUBLIC_AXON_URL"
  | "NEXT_PUBLIC_PULSE_URL"
  | "NEXT_PUBLIC_GYRUS_URL";

export interface PlatformAppDefinition {
  key: AppKey;
  name: string;
  description: string;
  icon: string;
  envVar: PlatformAppUrlEnvVar;
  defaultUrl: string;
  features: PlatformFeatureDefinition[];
}

export interface CortexApp {
  key: AppKey;
  name: string;
  description: string;
  url: string;
  icon: string;
}

export const DEV_PLATFORM_ADMIN_URL = "https://platform.dev.ctxhost.com/admin";
export const DEFAULT_PLATFORM_ADMIN_URL = DEV_PLATFORM_ADMIN_URL;

function inProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function runtimeEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function configuredAppUrl(app: PlatformAppDefinition): string | null {
  return runtimeEnv(app.envVar);
}

export function getOptionalAppUrl(app: PlatformAppDefinition): string | null {
  return configuredAppUrl(app) || (inProduction() ? null : app.defaultUrl);
}

export function derivePlatformAdminUrlFromEngramUrl(engramUrl: string): string {
  const url = new URL(engramUrl);
  if (url.hostname.startsWith("login.")) {
    url.hostname = url.hostname.replace(/^login\./, "platform.");
  } else if (!url.hostname.startsWith("platform.")) {
    const labels = url.hostname.split(".");
    if (labels.length > 1) {
      labels[0] = "platform";
      url.hostname = labels.join(".");
    } else {
      url.hostname = `platform.${url.hostname}`;
    }
  }
  url.pathname = "/admin";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export const PLATFORM_APPS: PlatformAppDefinition[] = [
  {
    // DB enum value is "dashboard" (Postgres `AppKey`); the user-facing
    // switcher transforms this to `key: "nexus"`, `label: "Nexus"`,
    // and a per-tenant URL (the Nexus tenant root) — see
    // `resolveEntitledApps` in the switcher route. The `defaultUrl`
    // here is the *operator-console* URL (Plexus), which is what
    // `getAllowedOrigins` returns in the OAuth / continue / login
    // redirect-validation paths. Renaming the enum + back-filling
    // entitlement rows is a separate migration PR.
    key: "dashboard",
    name: "Nexus",
    description: "Tenant workspace — apps, members, activity, settings",
    icon: "Box",
    envVar: "NEXT_PUBLIC_DASHBOARD_URL",
    defaultUrl: "https://plexus.dev.ctxhost.com",
    features: [],
  },
  {
    key: "synapse",
    name: "Synapse",
    description: "Team chat with agents and humans in the CORTEX mesh",
    icon: "MessageSquare",
    envVar: "NEXT_PUBLIC_SYNAPSE_URL",
    defaultUrl: "https://cortex.dev.ctxhost.com/synapse",
    features: [],
  },
  {
    key: "thoughts",
    name: "Thoughts",
    description: "Projects, tasks, and kanban boards for the CORTEX team",
    icon: "ListTodo",
    envVar: "NEXT_PUBLIC_THOUGHTS_URL",
    defaultUrl: "https://cortex.dev.ctxhost.com/thoughts",
    features: [
      {
        key: "projects",
        name: "Projects",
        description: "Project and kanban workflows in Thoughts.",
        // Thoughts' root (/thoughts) is the projects list — no suffix.
        path: "",
      },
      {
        key: "adr",
        name: "ADRs",
        description: "Architecture decision record workflows in Thoughts.",
        path: "/adrs",
      },
    ],
  },
  {
    key: "axon",
    name: "Axon",
    description: "Financial intelligence and portfolio analytics",
    icon: "TrendingUp",
    envVar: "NEXT_PUBLIC_AXON_URL",
    defaultUrl: "https://cortex.dev.ctxhost.com/axon",
    features: [],
  },
  {
    key: "pulse",
    name: "Pulse",
    description: "CRM and ticketing workflows for customer operations",
    icon: "HeartPulse",
    envVar: "NEXT_PUBLIC_PULSE_URL",
    defaultUrl: "https://cortex.dev.ctxhost.com/pulse",
    features: [],
  },
  {
    key: "gyrus",
    name: "Gyrus",
    description: "Net worth, budget, and account tracking",
    icon: "Wallet",
    envVar: "NEXT_PUBLIC_GYRUS_URL",
    defaultUrl: "https://cortex.dev.ctxhost.com/gyrus",
    features: [],
  },
];

export function getAppUrl(app: PlatformAppDefinition): string {
  return getOptionalAppUrl(app) || "";
}

/**
 * Absolute destination for a feature within an app: the app's base URL plus
 * the feature's `path` (when defined). Features without a path resolve to the
 * app root so the command palette always has a valid jump target.
 */
export function getFeatureUrl(
  app: PlatformAppDefinition,
  feature: PlatformFeatureDefinition,
): string {
  const base = getAppUrl(app);
  if (!feature.path) return base;
  return `${base.replace(/\/+$/, "")}${feature.path}`;
}

export function getCortexApps(): CortexApp[] {
  return PLATFORM_APPS.map((app) => ({
    key: app.key,
    name: app.name,
    description: app.description,
    url: getAppUrl(app),
    icon: app.icon,
  })).filter((app) => app.url);
}

export function getOptionalPlatformAdminUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_PLATFORM_ADMIN_URL?.trim();
  if (configured) return configured;

  const engramUrl = process.env.ENGRAM_URL?.trim();
  if (engramUrl) {
    try {
      return derivePlatformAdminUrlFromEngramUrl(engramUrl);
    } catch {
      return inProduction() ? null : DEV_PLATFORM_ADMIN_URL;
    }
  }

  return inProduction() ? null : DEV_PLATFORM_ADMIN_URL;
}

export function getPlatformAdminUrl(): string {
  return getOptionalPlatformAdminUrl() || "";
}

interface PostLoginOrgMembership {
  org?: {
    id?: string | null;
    slug?: string | null;
  } | null;
}

interface DefaultPostLoginTargetInput {
  role?: string;
  orgMemberships?: PostLoginOrgMembership[];
  /**
   * Caller-side opt-out from the SUPERADMIN platform-admin default. When
   * true, the SUPERADMIN branch is skipped and the routing falls through
   * to the regular tenant/account path. Used by the login page's "Sign in
   * to a tenant workspace" toggle so platform operators can land on their
   * workspace instead of the admin console.
   */
  preferWorkspace?: boolean;
  /**
   * The user's most-recently-used org ID (User.lastOrgId). When set and
   * still a current membership, the user lands on that org's Nexus.
   * Falls back to oldest membership (callers must orderBy: { createdAt: "asc" }).
   */
  lastOrgId?: string | null;
}

export function buildTenantWorkspaceUrl(slug: string): string {
  const platformAdminUrl = getOptionalPlatformAdminUrl();
  if (!platformAdminUrl) return "/account";

  try {
    const { hostname, port, protocol } = new URL(platformAdminUrl);
    const isDev = hostname.startsWith("platform.dev.");
    const rootDomain = isDev
      ? hostname.replace(/^platform\.dev\./, "")
      : hostname.replace(/^platform\./, "");
    const tenantHost = isDev ? `${slug}.dev.${rootDomain}` : `${slug}.${rootDomain}`;
    return `${protocol}//${tenantHost}${port ? `:${port}` : ""}/`;
  } catch {
    return `/account`;
  }
}

export function getDefaultPostLoginTarget({
  role,
  orgMemberships = [],
  preferWorkspace = false,
  lastOrgId,
}: DefaultPostLoginTargetInput = {}): string {
  if (role === "SUPERADMIN" && !preferWorkspace) {
    return getOptionalPlatformAdminUrl() || "/account";
  }

  if (orgMemberships.length === 0) {
    return "/account";
  }

  // Most-recently-used org takes priority when it's still a current membership.
  if (lastOrgId) {
    const lastOrgSlug = orgMemberships
      .find((m) => m.org?.id === lastOrgId)
      ?.org?.slug?.trim();
    if (lastOrgSlug) {
      return buildTenantWorkspaceUrl(lastOrgSlug);
    }
  }

  // Fall back to the oldest membership (callers must orderBy: { createdAt: "asc" }).
  const oldestSlug = orgMemberships
    .map((m) => m.org?.slug?.trim())
    .find((slug): slug is string => Boolean(slug));

  return oldestSlug ? buildTenantWorkspaceUrl(oldestSlug) : "/account";
}

/**
 * Default landing destination when login succeeds without a redirect_uri.
 * Overridable via NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING.
 */
export function getDefaultLandingUrl(): string {
  const configured =
    runtimeEnv("NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING") ||
    runtimeEnv("NEXT_PUBLIC_DASHBOARD_URL");
  if (configured) return configured;
  return inProduction() ? "/account" : PLATFORM_APPS[0].defaultUrl;
}
