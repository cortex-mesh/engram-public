import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

export const ENROLLMENT_CONSUMER_ID = "axon";
export const ENROLLMENT_CLIENT_ID = "axon-web";

function secureEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

function error(
  code: "UNAUTHENTICATED" | "CLIENT_SCOPE_FORBIDDEN",
  status: number,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message: "Enrollment consumer authentication failed.",
        retryable: false,
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** This is deliberately a distinct machine credential, never a browser cookie,
 * user JWT, generic internal API key, or caller-provided client selector. */
export function requireAxonEnrollmentConsumer(
  request: NextRequest,
):
  | {
      ok: true;
      consumerId: typeof ENROLLMENT_CONSUMER_ID;
      clientId: typeof ENROLLMENT_CLIENT_ID;
    }
  | { ok: false; response: NextResponse } {
  const expected = process.env.ENGRAM_AXON_ENROLLMENT_API_KEY?.trim();
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!expected || !supplied || !secureEqual(supplied, expected)) {
    return { ok: false, response: error("UNAUTHENTICATED", 401) };
  }
  if (
    request.nextUrl.searchParams.has("client_id") ||
    request.headers.has("x-engram-client-id")
  ) {
    return { ok: false, response: error("CLIENT_SCOPE_FORBIDDEN", 403) };
  }
  return {
    ok: true,
    consumerId: ENROLLMENT_CONSUMER_ID,
    clientId: ENROLLMENT_CLIENT_ID,
  };
}
