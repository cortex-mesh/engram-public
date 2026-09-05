// Internal-only service guard for /api/internal/* routes (Engram ADR-022).
// Admits ONLY the x-internal-api-key header — never a user cookie or JWT.
// Denials return 404 (not 401/403) with Cache-Control: no-store so the
// route's existence is not probeable by an unkeyed caller.

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

function keysMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function deny(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

export type InternalServiceResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

export function requireInternalService(
  request: NextRequest,
): InternalServiceResult {
  const expected = process.env.ENGRAM_INTERNAL_API_KEY;
  const provided = request.headers.get("x-internal-api-key");
  if (!expected || !provided || !keysMatch(provided, expected)) {
    return { ok: false, response: deny() };
  }
  return { ok: true };
}
