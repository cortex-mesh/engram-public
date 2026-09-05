import { NextResponse, type NextRequest } from "next/server";

import { isTrustedPublicOrigin } from "@/lib/organizations";

/**
 * Build CORS response headers for credentialed cross-origin reads.
 *
 * Returns a plain header bag the caller merges into its NextResponse.
 *
 * Allowed origin = exact echo of the request's `Origin` header if and only if
 * it's in `getTrustedPublicOrigins()` (ENGRAM_URL + ENGRAM_ALLOWED_ORIGINS).
 * Same-origin and untrusted-origin requests get no CORS headers — the browser
 * either doesn't need them or will block, both of which are correct.
 *
 * `Access-Control-Allow-Credentials: true` is set because the AppHeader fetch
 * uses `credentials: "include"`. Per spec, `*` is incompatible with credentials.
 */
export function credentialedReadCorsHeaders(
  request: NextRequest,
): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return { Vary: "Origin" };

  if (!isTrustedPublicOrigin(origin)) return { Vary: "Origin" };

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/**
 * Standard preflight response for credentialed reads. Always 204 with the
 * matched CORS headers (or empty headers if the origin is untrusted, which
 * the browser will treat as a CORS failure).
 */
export function preflightResponse(request: NextRequest): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: credentialedReadCorsHeaders(request),
  });
}
