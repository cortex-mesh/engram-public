import { createHash, randomBytes, timingSafeEqual } from "crypto";

import { isAppKey, type AppKey } from "@/lib/authorization";
import { sha256 } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const PKCE_CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const TENANT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NATIVE_CLIENT_APP_BINDINGS: Record<string, readonly AppKey[]> = {
  "synapse-native": ["synapse"],
  "tradepost-web": ["tradepost"],
  "axon-web": ["axon"],
  "fieldops-web": ["fieldops"],
};

export interface RegisteredNativeClient {
  clientId: string;
  displayName: string;
}

export type NativeAuthValidationErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant";

export class NativeAuthValidationError extends Error {
  constructor(
    readonly code: NativeAuthValidationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isValidNativeClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

export function validateNativeTenantSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return TENANT_SLUG_PATTERN.test(trimmed) ? trimmed : null;
}

export function validateNativeAppKey(value: unknown): AppKey | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isAppKey(trimmed) ? trimmed : null;
}

export function isNativeClientAllowedForApp(clientId: string, appKey: AppKey): boolean {
  return NATIVE_CLIENT_APP_BINDINGS[clientId]?.includes(appKey) ?? false;
}

export function nativeAppsForClient(clientId: string): readonly AppKey[] {
  return NATIVE_CLIENT_APP_BINDINGS[clientId] ?? [];
}

export function normalizeNativeRedirectUri(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  try {
    const url = new URL(trimmed);
    if (!url.protocol || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function validatePkceCodeChallenge(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return PKCE_CODE_CHALLENGE_PATTERN.test(trimmed) ? trimmed : null;
}

export function validatePkceCodeVerifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return PKCE_CODE_VERIFIER_PATTERN.test(trimmed) ? trimmed : null;
}

export async function findRegisteredNativeClient(
  clientId: string,
  redirectUri: string,
): Promise<RegisteredNativeClient | null> {
  const client = await prisma.nativeAuthClient.findUnique({
    where: { clientId },
    include: { redirectUris: true },
  });

  if (!client?.enabled) {
    return null;
  }

  const allowedRedirect = client.redirectUris.find(
    (candidate) => candidate.enabled && candidate.redirectUri === redirectUri,
  );
  if (!allowedRedirect) {
    return null;
  }

  return {
    clientId: client.clientId,
    displayName: client.displayName,
  };
}

export type NativeAuthorizationAdmissionReason =
  | "client_app_not_allowed"
  | "not_member"
  | "app_not_entitled"
  | "user_app_denied";

export interface NativeAuthorizedTenant {
  orgId: string;
  slug: string;
  displayName: string;
  tenantHost: string;
}

export function nativeTenantHostForLoginOrigin({
  slug,
  loginOrigin,
}: {
  slug: string;
  loginOrigin: string | URL;
}): string {
  const url = typeof loginOrigin === "string" ? new URL(loginOrigin) : loginOrigin;
  const hostname = url.hostname.toLowerCase();
  let tenantHostname: string;

  if (hostname.startsWith("login.dev.")) {
    tenantHostname = `${slug}.dev.${hostname.slice("login.dev.".length)}`;
  } else if (hostname.startsWith("login.")) {
    tenantHostname = `${slug}.${hostname.slice("login.".length)}`;
  } else {
    tenantHostname = `${slug}.${hostname}`;
  }

  return `${tenantHostname}${url.port ? `:${url.port}` : ""}`;
}

export async function listNativeAuthorizedTenants({
  clientId,
  userId,
  appKey,
  loginOrigin,
}: {
  clientId: string;
  userId: string;
  appKey: AppKey;
  loginOrigin: string | URL;
}): Promise<NativeAuthorizedTenant[]> {
  if (!isNativeClientAllowedForApp(clientId, appKey)) {
    return [];
  }

  const memberships = await prisma.orgMember.findMany({
    where: {
      userId,
      org: {
        is: {
          appEntitlements: {
            some: { appKey, enabled: true },
          },
          userAppOverrides: {
            none: { userId, appKey, enabled: false },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    include: {
      org: { select: { id: true, slug: true, name: true } },
    },
  });

  return memberships.map((membership) => ({
    orgId: membership.org.id,
    slug: membership.org.slug,
    displayName: membership.org.name,
    tenantHost: nativeTenantHostForLoginOrigin({
      slug: membership.org.slug,
      loginOrigin,
    }),
  }));
}

export async function validateNativeAuthorizationAdmission({
  clientId,
  userId,
  tenantSlug,
  appKey,
}: {
  clientId: string;
  userId: string;
  tenantSlug: string;
  appKey: AppKey;
}): Promise<
  | { allowed: true; orgId: string }
  | { allowed: false; reason: NativeAuthorizationAdmissionReason }
> {
  if (!isNativeClientAllowedForApp(clientId, appKey)) {
    return { allowed: false, reason: "client_app_not_allowed" };
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: tenantSlug },
    select: {
      id: true,
      members: {
        where: { userId },
        select: { id: true },
      },
      appEntitlements: {
        where: { appKey },
        select: { enabled: true },
      },
      userAppOverrides: {
        where: { userId, appKey },
        select: { enabled: true },
      },
    },
  });

  if (!organization || organization.members.length === 0) {
    return { allowed: false, reason: "not_member" };
  }

  const appEntitled = organization.appEntitlements.some(
    (entitlement) => entitlement.enabled,
  );
  if (!appEntitled) {
    return { allowed: false, reason: "app_not_entitled" };
  }

  if (organization.userAppOverrides.some((override) => !override.enabled)) {
    return { allowed: false, reason: "user_app_denied" };
  }

  return { allowed: true, orgId: organization.id };
}

export async function issueNativeAuthorizationCode({
  clientId,
  userId,
  redirectUri,
  codeChallenge,
}: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await prisma.nativeAuthAuthorizationCode.create({
    data: {
      clientId,
      userId,
      redirectUri,
      codeChallenge,
      codeHash: sha256(code),
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    },
  });
  return code;
}

export async function consumeNativeAuthorizationCode({
  code,
  clientId,
  redirectUri,
  codeVerifier,
}: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ userId: string }> {
  const verifier = validatePkceCodeVerifier(codeVerifier);
  if (!verifier) {
    throw new NativeAuthValidationError("invalid_grant", "Invalid PKCE verifier.");
  }

  const authorizationCode = await prisma.nativeAuthAuthorizationCode.findFirst({
    where: {
      codeHash: sha256(code),
      clientId,
      redirectUri,
      consumedAt: null,
    },
  });

  if (!authorizationCode || authorizationCode.expiresAt.getTime() <= Date.now()) {
    throw new NativeAuthValidationError(
      "invalid_grant",
      "Authorization code is invalid or expired.",
    );
  }

  if (!doesPkceVerifierMatch(verifier, authorizationCode.codeChallenge)) {
    throw new NativeAuthValidationError("invalid_grant", "PKCE verifier mismatch.");
  }

  const consumed = await prisma.nativeAuthAuthorizationCode.updateMany({
    where: {
      id: authorizationCode.id,
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) {
    throw new NativeAuthValidationError("invalid_grant", "Authorization code was consumed.");
  }

  return { userId: authorizationCode.userId };
}

export function doesPkceVerifierMatch(verifier: string, expectedChallenge: string): boolean {
  const computedChallenge = createHash("sha256").update(verifier).digest("base64url");
  const left = Buffer.from(computedChallenge);
  const right = Buffer.from(expectedChallenge);
  return left.length === right.length && timingSafeEqual(left, right);
}
