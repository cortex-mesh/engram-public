import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { REFRESH_COOKIE_NAME, clearAuthCookies, verifyToken } from "@/lib/jwt";
import { sha256 } from "@/lib/crypto";
import { recordAuditEvent } from "@/lib/audit";
import { REFRESH_GRACE_WINDOW_MS } from "@/lib/refresh-rotation";

// The browser may send more than one refresh cookie (host-only + domain
// variants share the name). request.cookies is keyed by name and drops
// duplicates, so parse the raw header to revoke every presented token.
function getAllCookieValues(request: NextRequest, name: string): string[] {
  const header = request.headers.get("cookie") ?? "";
  return header
    .split(/;\s*/)
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1))
    .filter(Boolean);
}

export async function POST(request: NextRequest) {
  try {
    const refreshTokens = getAllCookieValues(request, REFRESH_COOKIE_NAME);
    if (refreshTokens.length === 0) {
      try {
        const body = await request.json();
        const bodyToken = body.refreshToken || body.refresh_token;
        if (typeof bodyToken === "string" && bodyToken) {
          refreshTokens.push(bodyToken);
        }
      } catch {
        // No body — logout should still be idempotent.
      }
    }

    // Revoke every refresh token the client presented. Best-effort attribution:
    // decode (not trust) the token to record who logged out, and — so a replay
    // of a just-rotated token can't be graced back into a session after logout
    // (ADR-031) — also clear that user's within-grace consumed predecessors.
    // Other devices' active tokens (consumedAt = null, different hash) are left
    // untouched, keeping logout per-device.
    if (refreshTokens.length > 0) {
      let actorUserId: string | undefined;
      try {
        const payload = await verifyToken(refreshTokens[0]);
        actorUserId = payload.userId;
      } catch {
        // Unverifiable token — log the logout without an actor.
      }

      const presentedHashes = refreshTokens.map(sha256);
      await prisma.refreshToken
        .deleteMany({
          where: actorUserId
            ? {
                userId: actorUserId,
                OR: [
                  { tokenHash: { in: presentedHashes } },
                  { consumedAt: { gte: new Date(Date.now() - REFRESH_GRACE_WINDOW_MS) } },
                ],
              }
            : { tokenHash: { in: presentedHashes } },
        })
        .catch(() => {});
      await recordAuditEvent({
        action: "logout.success",
        outcome: "success",
        actorUserId,
        actorType: actorUserId ? "user" : "anonymous",
        targetType: actorUserId ? "user" : undefined,
        targetId: actorUserId,
        request,
      });
    }

    // Clear cookies
    const response = NextResponse.json({ ok: true });
    clearAuthCookies(response);

    return response;
  } catch {
    // Even on error, clear cookies and return ok
    const response = NextResponse.json({ ok: true });
    clearAuthCookies(response);
    return response;
  }
}
