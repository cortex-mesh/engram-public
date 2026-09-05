import type { NextRequest } from "next/server";

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function configuredOrigin(): string | null {
  const configuredUrl = process.env.ENGRAM_URL?.trim();
  if (configuredUrl) {
    try {
      return new URL(configuredUrl).origin;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Server-owned platform authority for destinations such as native tenant
 * hosts. Unlike getPublicOrigin, this must never adopt a branded auth alias
 * or any request header.
 */
export function getCanonicalPlatformOrigin(): string {
  return configuredOrigin() || "https://login.dev.ctxhost.com";
}

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.ENGRAM_ALLOWED_HOSTS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Returns the proxy-selected host only when it is explicitly configured as a
 * public Engram host. This is deliberately shared by public-origin and
 * host-bound client routing: a Host header is not an authority boundary on
 * its own.
 */
export function getAllowedRequestHost(headers: Headers): string | null {
  const configuredHosts = allowedHosts();
  const host = firstHeaderValue(headers.get("host"))?.toLowerCase() || null;
  // A public Host is the end-user authority. Never let a forwarded header
  // downgrade it to another allowed host, or a Cite request can lose its
  // host-bound client isolation. Only use X-Forwarded-Host when Host is an
  // internal/unrecognized authority supplied by a trusted proxy.
  if (host && configuredHosts.has(host)) return host;

  const forwardedHost = firstHeaderValue(headers.get("x-forwarded-host"))?.toLowerCase() || null;
  return forwardedHost && configuredHosts.has(forwardedHost) ? forwardedHost : null;
}

export function getAllowedPublicOrigins(): string[] {
  const origins = [configuredOrigin()].filter((value): value is string => !!value);
  for (const host of allowedHosts()) {
    origins.push(`https://${host}`);
  }
  return Array.from(new Set(origins));
}

export function getPublicOrigin(request: NextRequest): string {
  const host = getAllowedRequestHost(request.headers);
  if (host) {
    return `https://${host}`;
  }

  return configuredOrigin() || request.nextUrl.origin;
}
