import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { verifyToken, ACCESS_COOKIE_NAME } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";
import { isPlatformSuperadmin } from "@/lib/authorization";
import { getRequestCookieValues } from "@/lib/cookie-tokens";

export interface AuthResult {
  userId: string;
  role: string;
}

/**
 * Re-read the caller's CURRENT platform role from the DB rather than trusting
 * the `role` claim baked into the 15-minute access token (audit #9). Use this
 * for privileged platform-superadmin gates so a demoted/revoked superadmin
 * loses access immediately instead of at token expiry. The internal API key
 * (`userId === "internal"`) is never a platform superadmin.
 */
export async function isCurrentPlatformSuperadmin(
  auth: { userId: string } | null,
): Promise<boolean> {
  if (!auth || auth.userId === "internal") return false;
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { role: true },
  });
  return isPlatformSuperadmin(user?.role);
}

/**
 * Authenticate an incoming HTTP request.
 *
 * Priority order:
 * 1. X-Internal-API-Key header (trusted internal services)
 * 2. engram-access cookie (JWT access token)
 * 3. Authorization: Bearer <JWT>
 *
 * Returns { userId, role } or null if unauthenticated.
 */
export async function authenticateRequest(
  request: NextRequest,
): Promise<AuthResult | null> {
  // 1. Internal API key (service-to-service)
  const internalKey = request.headers.get("x-internal-api-key");
  const expectedKey = process.env.ENGRAM_INTERNAL_API_KEY;
  if (internalKey && expectedKey && internalKey.length === expectedKey.length && timingSafeEqual(Buffer.from(internalKey), Buffer.from(expectedKey))) {
    return { userId: "internal", role: "ADMIN" };
  }

  // 2. JWT from engram-access cookie
  const jwtCookies = getRequestCookieValues(request, ACCESS_COOKIE_NAME);
  for (const jwtCookie of jwtCookies) {
    try {
      const payload = await verifyToken(jwtCookie);
      if (payload.type === "access") {
        return { userId: payload.userId, role: payload.role || "USER" };
      }
    } catch {
      // Invalid JWT cookie — fall through
    }
  }

  // 3. JWT from Authorization: Bearer header
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const bearerToken = match ? match[1] : null;
    if (bearerToken) {
      try {
        const payload = await verifyToken(bearerToken);
        if (payload.type === "access") {
          return { userId: payload.userId, role: payload.role || "USER" };
        }
      } catch {
        // Invalid JWT — fall through
      }
    }
  }

  return null;
}
