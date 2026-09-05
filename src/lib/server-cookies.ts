import { cookies, headers } from "next/headers";
import { ACCESS_COOKIE_NAME } from "@/lib/jwt";

/**
 * Returns the Engram access token for the current server-component request.
 *
 * Three-tier read (Next.js 16.2.x standalone regression workaround):
 * 1. cookies() — spec-compliant path. Works in dev and in any version where
 *    the standalone AsyncLocalStorage work-unit store is correctly populated.
 * 2. x-engram-access header — set by middleware.ts when cookies() would be
 *    empty. Only visible if headers() sees middleware-rewritten request headers
 *    (may also be affected by the standalone regression).
 * 3. Raw "cookie" header parse — reads the Cookie header directly from
 *    headers() and parses it manually. This bypasses the cookies() parsing
 *    layer entirely; if headers() returns the original request headers even
 *    when cookies() is broken, this recovers the token.
 */
export async function getAccessTokenFromRequest(): Promise<string | undefined> {
  const cookieStore = await cookies();
  const fromCookies = cookieStore.get(ACCESS_COOKIE_NAME)?.value;
  if (fromCookies) return fromCookies;

  const headerStore = await headers();

  const fromMiddlewareHeader = headerStore.get("x-engram-access");
  if (fromMiddlewareHeader) return fromMiddlewareHeader;

  // Parse the raw Cookie header — works when headers() sees the original
  // request headers even if cookies() is not populated (standalone regression).
  const rawCookies = headerStore.get("cookie");
  if (rawCookies) {
    for (const part of rawCookies.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx !== -1 && part.slice(0, eqIdx).trim() === ACCESS_COOKIE_NAME) {
        return part.slice(eqIdx + 1).trim();
      }
    }
  }

  return undefined;
}
