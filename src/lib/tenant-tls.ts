import { RESERVED_ORG_SLUGS } from "@/lib/organizations";

export type TenantTlsEnvironment = "dev" | "prod";

export interface TenantTlsDomain {
  slug: string;
  environment: TenantTlsEnvironment;
  hostname: string;
}

const ORG_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_TENANT_TLS_SLUGS = new Set([...RESERVED_ORG_SLUGS, "cortex"]);
const TENANT_DOMAIN_SUFFIXES: Array<{ suffix: string; environment: TenantTlsEnvironment }> = [
  { suffix: ".dev.ctxhost.com", environment: "dev" },
  { suffix: ".ctxhost.com", environment: "prod" },
];

function stripTrailingDot(hostname: string) {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

export function parseTenantTlsDomain(value: string | null): TenantTlsDomain | null {
  const hostname = stripTrailingDot((value || "").trim().toLowerCase());
  if (!hostname) {
    return null;
  }

  const match = TENANT_DOMAIN_SUFFIXES.find(({ suffix }) => hostname.endsWith(suffix));
  if (!match) {
    return null;
  }

  const slug = hostname.slice(0, -match.suffix.length);
  if (!slug || slug.includes(".") || !ORG_SLUG_REGEX.test(slug)) {
    return null;
  }

  if (RESERVED_TENANT_TLS_SLUGS.has(slug)) {
    return null;
  }

  return {
    slug,
    environment: match.environment,
    hostname,
  };
}

export function isLoopbackRequestHost(value: string | null): boolean {
  const host = stripTrailingDot((value || "").trim().toLowerCase());
  if (!host) {
    return false;
  }

  if (host === "[::1]" || host.startsWith("[::1]:")) {
    return true;
  }

  const hostname = host.replace(/:\d+$/, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
