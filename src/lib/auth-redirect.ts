import {
  PLATFORM_APPS,
  getOptionalAppUrl,
  getDefaultLandingUrl,
  getOptionalPlatformAdminUrl,
} from "@/lib/apps";
import { getAllowedPublicOrigins } from "@/lib/public-origin";

export const OAUTH_REDIRECT_COOKIE_NAME = "oauth-redirect-uri";

const RESERVED_TENANT_SUBDOMAINS = new Set([
  "api",
  "dashboard",
  "dev",
  "engram",
  "login",
  "platform",
  "plexus",
  "staging",
  "stg",
  "www",
]);

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();

  const candidates = [
    process.env.ENGRAM_URL,
    getDefaultLandingUrl(),
    getOptionalPlatformAdminUrl(),
    ...PLATFORM_APPS.map((app) => getOptionalAppUrl(app)),
    // Every host Engram is allowed to serve is also a host it must be able to
    // send a user back to. A branded auth host (auth.ccgtradepost.com) serves
    // /authorize, so the OAuth return target lives there — but it is not
    // ENGRAM_URL and it is not an app URL, so without this it was rejected as
    // an untrusted redirect and the authorize parameters were dropped on the
    // way back from Google.
    ...getAllowedPublicOrigins(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // ignore invalid env/config URLs
    }
  }

  return origins;
}

function getAllowedTenantWildcardOrigins(): URL[] {
  const wildcardOrigins: URL[] = [];

  try {
    const configuredPlatformAdminUrl = getOptionalPlatformAdminUrl();
    if (!configuredPlatformAdminUrl) return wildcardOrigins;
    const platformAdminUrl = new URL(configuredPlatformAdminUrl);
    const devMatch = platformAdminUrl.hostname.match(/^platform\.dev\.(.+)$/);
    const prodMatch = platformAdminUrl.hostname.match(/^platform\.(.+)$/);

    if (devMatch) {
      wildcardOrigins.push(
        new URL(
          `${platformAdminUrl.protocol}//dev.${devMatch[1]}${platformAdminUrl.port ? `:${platformAdminUrl.port}` : ""}`,
        ),
      );
    }
    if (prodMatch) {
      wildcardOrigins.push(
        new URL(
          `${platformAdminUrl.protocol}//${prodMatch[1]}${platformAdminUrl.port ? `:${platformAdminUrl.port}` : ""}`,
        ),
      );
    }
  } catch {
    // ignore invalid platform admin URL
  }

  return wildcardOrigins;
}

function getDirectTenantSubdomain(
  hostname: string,
  tenantRoot: string,
): string | null {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedRoot = tenantRoot.toLowerCase();
  const suffix = `.${normalizedRoot}`;

  if (!normalizedHostname.endsWith(suffix)) {
    return null;
  }

  const subdomain = normalizedHostname.slice(0, -suffix.length);
  if (!subdomain || subdomain.includes(".")) {
    return null;
  }

  return subdomain;
}

export function isAllowedRedirect(uri: string | null | undefined): boolean {
  if (!uri) return false;
  if (uri.startsWith("/") && !uri.startsWith("//") && !uri.startsWith("/\\")) {
    return true;
  }

  try {
    const url = new URL(uri);
    const allowedOrigins = getAllowedOrigins();
    if (allowedOrigins.has(url.origin)) {
      return true;
    }

    return getAllowedTenantWildcardOrigins().some((allowed) => {
      const allowedPort =
        allowed.port || (allowed.protocol === "https:" ? "443" : "80");
      const urlPort = url.port || (url.protocol === "https:" ? "443" : "80");
      const tenantSubdomain = getDirectTenantSubdomain(
        url.hostname,
        allowed.hostname,
      );

      return (
        url.protocol === allowed.protocol &&
        urlPort === allowedPort &&
        tenantSubdomain !== null &&
        !RESERVED_TENANT_SUBDOMAINS.has(tenantSubdomain)
      );
    });
  } catch {
    return false;
  }
}

export function getSafeRedirectTarget(
  uri: string | null | undefined,
  fallback: string,
): string {
  return isAllowedRedirect(uri) ? uri! : fallback;
}

export function withAccountClientContext(
  target: string,
  clientId: string | null | undefined,
): string {
  if (!clientId) return target;

  const isAbsolute = target.startsWith("http://") || target.startsWith("https://");
  try {
    const url = new URL(target, "https://engram.local");
    if (url.pathname !== "/account" || url.searchParams.has("client_id")) {
      return target;
    }
    url.searchParams.set("client_id", clientId);
    return isAbsolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return target;
  }
}

export function toAbsoluteRedirectTarget(
  target: string,
  currentOrigin: string,
): string {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return target;
  }
  return `${currentOrigin}${target}`;
}
