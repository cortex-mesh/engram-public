import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ORIGIN_SECRET_HEADER = "x-engram-origin-secret";

function enforceProdOriginSecret(request: NextRequest): NextResponse | null {
  if (process.env.ENGRAM_DEPLOY_ENV !== "prod") return null;

  const expectedSecret = process.env.ENGRAM_ORIGIN_SECRET;
  const actualSecret = request.headers.get(ORIGIN_SECRET_HEADER);
  if (!expectedSecret || actualSecret !== expectedSecret) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return null;
}

// In Next.js 16.2.6 standalone, cookies() from next/headers does not return
// cookie values in server components even though the Cookie request header
// reaches the origin (API route handlers using request.cookies are unaffected).
// This middleware reads the access token via request.cookies (which works) and
// forwards it as x-engram-access so server components can read it via headers()
// as a reliable workaround. Strip any externally-supplied x-engram-access to
// prevent header injection — our value always wins.
export function middleware(request: NextRequest) {
  const originSecretFailure = enforceProdOriginSecret(request);
  if (originSecretFailure) return originSecretFailure;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(ORIGIN_SECRET_HEADER);
  requestHeaders.delete("x-engram-access");
  requestHeaders.delete("x-engram-request-path");

  requestHeaders.set(
    "x-engram-request-path",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );

  const token = request.cookies.get("engram-access")?.value;
  if (token) {
    requestHeaders.set("x-engram-access", token);
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/:path*"],
};
