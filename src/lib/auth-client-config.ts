import { cache } from "react";

import { prisma } from "@/lib/prisma";
import { isValidNativeClientId } from "@/lib/native-auth";
import { decodeRedirectTarget } from "@/lib/redirect-target";

export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export type SignupMode = "waitlist" | "open";

export interface PublicAuthClientConfig {
  clientId: string | null;
  displayName: string;
  brandName: string;
  brandTagline: string;
  brandLogoUrl: string | null;
  brandPrimaryColor: string | null;
  authProviders: OAuthProvider[];
  signupMode: SignupMode;
  securedByEngram: boolean;
}

const DEFAULT_CONFIG: PublicAuthClientConfig = {
  clientId: null,
  displayName: "CORTEX",
  brandName: "CORTEX",
  brandTagline: "One door into the mesh.",
  brandLogoUrl: null,
  brandPrimaryColor: null,
  authProviders: ["google", "github"],
  signupMode: "waitlist",
  securedByEngram: false,
};

const DEFAULT_OAUTH_CALLBACK_POLICY = {
  clientId: null,
  authProviders: ["google", "github"] as OAuthProvider[],
  signupMode: "waitlist" as SignupMode,
};

// Used only when a resolved (securedByEngram) branded client has no DB
// tagline of its own. DEFAULT_CONFIG.brandTagline is mesh/CORTEX-flavored
// promotional copy — inappropriate on a branded client's own hero.
const BRANDED_FALLBACK_TAGLINE = "Secure sign-in for your workspace";

function toOAuthProviders(values: string[] | undefined): OAuthProvider[] {
  const providers = (values || []).filter((value): value is OAuthProvider =>
    OAUTH_PROVIDERS.includes(value as OAuthProvider),
  );
  return providers.length > 0 ? providers : DEFAULT_CONFIG.authProviders;
}

/**
 * Returns the authorization policy used by an OAuth callback. This is
 * deliberately separate from getPublicAuthClientConfig: the latter is a UI
 * helper and may safely fall back to the default presentation when a branded
 * client cannot be rendered. A callback must never turn that presentation
 * fallback into authorization for a missing, disabled, or malformed client.
 */
export async function getOAuthCallbackClientPolicy(
  clientId: string | null | undefined,
): Promise<{ clientId: string | null; authProviders: OAuthProvider[]; signupMode: SignupMode } | null> {
  // The unbranded platform sign-in flow intentionally uses the server-owned
  // default policy. Any supplied native client must be found and enabled.
  if (!clientId) {
    return DEFAULT_OAUTH_CALLBACK_POLICY;
  }
  if (!isValidNativeClientId(clientId)) {
    return null;
  }

  const client = await prisma.nativeAuthClient.findUnique({
    where: { clientId },
    select: { clientId: true, enabled: true, authProviders: true, signupMode: true },
  });
  if (!client?.enabled) {
    return null;
  }

  const authProviders = (client.authProviders || []).filter((value): value is OAuthProvider =>
    OAUTH_PROVIDERS.includes(value as OAuthProvider),
  );
  if (authProviders.length === 0) {
    return null;
  }
  return {
    clientId: client.clientId,
    authProviders,
    signupMode: normalizeSignupMode(client.signupMode),
  };
}

export function normalizeSignupMode(value: unknown): SignupMode {
  return value === "open" ? "open" : "waitlist";
}

export function extractClientIdFromRedirectUri(value: string | null | undefined): string | null {
  return extractClientIdsFromContinuation(value).find(isValidNativeClientId) || null;
}

const MAX_CONTINUATION_DEPTH = 4;
const MAX_CONTINUATION_LENGTH = 4096;
const MAX_CONTINUATION_VISITS = 32;
export const CONTINUATION_REJECTION_MARKER = "__engram_continuation_rejected__";

/**
 * Collects all client_id values carried by a continuation URL. Continuations
 * may nest legacy redirect_uri values and durable rt values; keep traversal
 * bounded and preserve malformed identifiers so host-bound routing rejects
 * ambiguity instead of treating it as absent.
 */
export function extractClientIdsFromContinuation(value: string | null | undefined): string[] {
  const identifiers = new Set<string>();
  const visited = new Set<string>();
  let visits = 0;

  function reject() {
    identifiers.add(CONTINUATION_REJECTION_MARKER);
  }

  function visitEncodedTarget(encodedTarget: string | null | undefined, depth: number) {
    if (!encodedTarget) {
      reject();
      return;
    }
    const decodedTarget = decodeRedirectTarget(encodedTarget);
    if (!decodedTarget) {
      reject();
      return;
    }
    visit(decodedTarget, depth);
  }

  function visit(target: string | null | undefined, depth: number) {
    if (target === null || target === undefined) return;
    if (!target) {
      reject();
      return;
    }
    if (visited.has(target)) return;
    if (
      depth > MAX_CONTINUATION_DEPTH ||
      target.length > MAX_CONTINUATION_LENGTH ||
      visits >= MAX_CONTINUATION_VISITS
    ) {
      reject();
      return;
    }
    visited.add(target);
    visits += 1;
    try {
      const url = new URL(target, "https://login.dev.ctxhost.com");
      for (const clientId of url.searchParams.getAll("client_id")) {
        if (clientId) identifiers.add(clientId);
      }
      for (const redirectUri of url.searchParams.getAll("redirect_uri")) {
        visit(redirectUri, depth + 1);
      }
      for (const encodedTarget of url.searchParams.getAll("rt")) {
        visitEncodedTarget(encodedTarget, depth + 1);
      }
    } catch {
      reject();
    }
  }

  visit(value, 0);
  return [...identifiers];
}

/**
 * Returns every supplied client identifier carried by a request, including
 * client_id values nested inside both the legacy redirect_uri and durable rt
 * continuation target. Callers must pass the complete set to the host-bound
 * resolver rather than allowing a direct value to mask a nested value. Values
 * are deliberately not filtered for registration here: a malformed or
 * unregistered value is still a conflicting host-bound client selection.
 */
export function extractRequestedClientIds(params: URLSearchParams): string[] {
  const identifiers = new Set<string>();
  for (const clientId of params.getAll("client_id")) {
    if (clientId) identifiers.add(clientId);
  }
  for (const redirectUri of params.getAll("redirect_uri")) {
    for (const clientId of extractClientIdsFromContinuation(redirectUri)) {
      identifiers.add(clientId);
    }
  }
  for (const target of params.getAll("rt")) {
    if (!target) {
      identifiers.add(CONTINUATION_REJECTION_MARKER);
      continue;
    }
    const decodedTarget = decodeRedirectTarget(target);
    if (!decodedTarget) {
      identifiers.add(CONTINUATION_REJECTION_MARKER);
      continue;
    }
    for (const clientId of extractClientIdsFromContinuation(decodedTarget)) {
      identifiers.add(clientId);
    }
  }
  return [...identifiers];
}

export function extractRequestedClientId(params: URLSearchParams): string | null {
  return extractRequestedClientIds(params)[0] || null;
}

export const getPublicAuthClientConfig = cache(async function getPublicAuthClientConfig(
  clientId: string | null | undefined,
): Promise<PublicAuthClientConfig> {
  if (!clientId || !isValidNativeClientId(clientId)) {
    return DEFAULT_CONFIG;
  }

  const client = await prisma.nativeAuthClient.findUnique({
    where: { clientId },
    select: {
      clientId: true,
      displayName: true,
      brandName: true,
      brandTagline: true,
      brandLogoUrl: true,
      brandPrimaryColor: true,
      authProviders: true,
      signupMode: true,
      enabled: true,
    },
  });

  if (!client?.enabled) {
    return DEFAULT_CONFIG;
  }

  return {
    clientId: client.clientId,
    displayName: client.displayName,
    brandName: client.brandName || client.displayName,
    brandTagline: client.brandTagline || BRANDED_FALLBACK_TAGLINE,
    brandLogoUrl: client.brandLogoUrl,
    brandPrimaryColor: client.brandPrimaryColor,
    authProviders: toOAuthProviders(client.authProviders),
    signupMode: normalizeSignupMode(client.signupMode),
    securedByEngram: true,
  };
});

export type AuthSearchParams = Record<string, string | string[] | undefined>;

export function toUrlSearchParams(searchParams: AuthSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params;
}

export async function resolveClientConfigFromSearchParams(
  searchParams: Promise<AuthSearchParams> | AuthSearchParams | undefined,
): Promise<PublicAuthClientConfig> {
  const resolvedParams = searchParams instanceof Promise ? await searchParams : searchParams;
  const params = toUrlSearchParams(resolvedParams ?? {});
  return getPublicAuthClientConfig(extractRequestedClientId(params));
}

export async function getSignupModeForClient(clientId: string | null | undefined): Promise<SignupMode> {
  return (await getPublicAuthClientConfig(clientId)).signupMode;
}
