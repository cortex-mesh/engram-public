import { getAllowedRequestHost } from "@/lib/public-origin";
import { CONTINUATION_REJECTION_MARKER } from "@/lib/auth-client-config";
import { getSafeRedirectTarget, isAllowedRedirect } from "@/lib/auth-redirect";
import { prisma } from "@/lib/prisma";

export const CITE_THE_MOVE_AUTH_HOST = "auth.citethemove.com";
export const CITE_THE_MOVE_CLIENT_ID = "axon-web";
export const CITE_THE_MOVE_CALLBACK = "https://app.citethemove.com/auth/callback";

const HOST_BOUND_CLIENTS: Readonly<Record<string, string>> = {
  [CITE_THE_MOVE_AUTH_HOST]: CITE_THE_MOVE_CLIENT_ID,
};

export type AuthClientHostResolution =
  | { clientId: string | null; rejected: false }
  | { clientId: null; rejected: true };

/**
 * Returns the continuation fallback owned by a branded auth host.
 *
 * Cite's app callback is registered for explicit OAuth flows, but the app is
 * not yet a viable bare-root destination. Keep bare auth.citethemove.com
 * requests on the host's own account surface instead of inheriting Engram's
 * process-wide landing URL (currently Tradepost in production).
 */
export function getHostBoundContinuationFallback(
  _clientId: string | null,
  allowedHost: string | null,
): string | null {
  const hostClientId = allowedHost ? HOST_BOUND_CLIENTS[allowedHost] : undefined;
  return hostClientId ? `/account?client_id=${hostClientId}` : null;
}

/**
 * Branded auth hosts may continue only to a same-host relative route or to an
 * enabled redirect URI owned by their enabled client. This is deliberately
 * stricter than the platform-wide redirect allowlist: a destination trusted
 * for Tradepost must not become a Cite continuation destination merely
 * because both applications use Engram.
 */
export async function isAllowedHostBoundContinuationTarget(
  target: string | null | undefined,
  clientId: string | null,
  allowedHost: string | null,
): Promise<boolean> {
  const hostClientId = allowedHost ? HOST_BOUND_CLIENTS[allowedHost] : undefined;
  if (!hostClientId) {
    return isAllowedRedirect(target);
  }

  if (!target || clientId !== hostClientId) {
    return false;
  }

  // Relative routes remain on the current allowlisted branded auth host.
  if (target.startsWith("/") && !target.startsWith("//") && !target.startsWith("/\\")) {
    return true;
  }

  // Cite's branded host has exactly one external continuation. Do this check
  // before consulting the mutable native-client registry so an enabled
  // axon-web redirect row for another environment cannot widen this boundary.
  if (target !== CITE_THE_MOVE_CALLBACK) {
    return false;
  }

  try {
    const client = await prisma.nativeAuthClient.findUnique({
      where: { clientId },
      select: {
        enabled: true,
        redirectUris: {
          where: { redirectUri: target, enabled: true },
          select: { id: true },
          take: 1,
        },
      },
    });
    return client?.enabled === true && client.redirectUris.length === 1;
  } catch {
    // A redirect registration lookup failure must not widen a branded host's
    // continuation boundary. Callers fall back to a same-host destination.
    return false;
  }
}

export async function getSafeHostBoundContinuationTarget(
  target: string | null | undefined,
  fallback: string,
  clientId: string | null,
  allowedHost: string | null,
): Promise<string> {
  if (await isAllowedHostBoundContinuationTarget(target, clientId, allowedHost)) {
    return target!;
  }
  // A caller's normal post-login fallback can be a tenant or platform-admin
  // URL. A rejected/missing continuation on a bound auth host must never use
  // that external fallback; it stays on the host-owned account surface.
  return getHostBoundContinuationFallback(clientId, allowedHost)
    || getSafeRedirectTarget(target, fallback);
}

/**
 * A branded host is a first-party client boundary, not merely a visual hint.
 * Once a request reaches one of these allowlisted hosts, it gets that host's
 * client by default and cannot switch to another client through query/body
 * parameters or a nested redirect URI.
 */
export function resolveAuthClientForHost(
  requestedClientIds: string | readonly (string | null | undefined)[] | null,
  allowedHost: string | null,
): AuthClientHostResolution {
  const clientIds = Array.from(new Set(
    (Array.isArray(requestedClientIds) ? requestedClientIds : [requestedClientIds])
      .filter((clientId): clientId is string => !!clientId),
  ));
  if (clientIds.includes(CONTINUATION_REJECTION_MARKER) || clientIds.length > 1) {
    return { clientId: null, rejected: true };
  }
  const requestedClientId = clientIds[0] || null;
  const hostClientId = allowedHost ? HOST_BOUND_CLIENTS[allowedHost] : undefined;
  if (!hostClientId) {
    return { clientId: requestedClientId, rejected: false };
  }
  if (requestedClientId && requestedClientId !== hostClientId) {
    return { clientId: null, rejected: true };
  }
  return { clientId: hostClientId, rejected: false };
}

export function resolveAuthClientForRequest(
  requestedClientIds: string | readonly (string | null | undefined)[] | null,
  headers: Headers,
): AuthClientHostResolution {
  return resolveAuthClientForHost(requestedClientIds, getAllowedRequestHost(headers));
}
