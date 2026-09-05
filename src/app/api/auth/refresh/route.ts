import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyToken,
  REFRESH_COOKIE_NAME,
  ACCESS_COOKIE_NAME,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from "@/lib/jwt";
import { rotateRefreshToken, revokeTokenFamily } from "@/lib/refresh-rotation";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
} from "@/lib/rate-limit";

// Generous — web clients refresh every ~15 min per tab, but a single IP
// hammering refresh is rotation abuse or a stolen-token probe.
const IP_LIMIT = 60;
const IP_WINDOW_MS = 60 * 1000;

export async function POST(request: NextRequest) {
  try {
    const ipLimit = await consumeRateLimit(
      `refresh:ip:${getClientIp(request)}`,
      IP_LIMIT,
      IP_WINDOW_MS,
    );
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.retryAfterSeconds);
    }

    // Read refresh token from cookie or body
    let token = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
    let tokenSource: "cookie" | "body" = "cookie";

    if (!token) {
      try {
        const body = await request.json();
        const bodyToken = body.refreshToken || body.refresh_token;
        token = typeof bodyToken === "string" ? bodyToken : undefined;
        tokenSource = "body";
      } catch {
        // No body — that's fine
      }
    }

    if (!token) {
      console.warn("[engram][refresh] missing refresh token");
      return NextResponse.json(
        { error: "Refresh token required" },
        { status: 401 },
      );
    }

    // Verify JWT
    let payload;
    try {
      payload = await verifyToken(token);
    } catch {
      console.warn("[engram][refresh] invalid or expired refresh token");
      return NextResponse.json(
        { error: "Invalid or expired refresh token" },
        { status: 401 },
      );
    }

    // Ensure this is actually a refresh token, not an access token
    if (payload.type !== "refresh") {
      console.warn("[engram][refresh] invalid token type", { type: payload.type });
      return NextResponse.json(
        { error: "Invalid token type" },
        { status: 401 },
      );
    }

    // Look up the user up front — needed to mint the replacement, and avoids
    // consuming the token if the account is gone.
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user) {
      console.warn("[engram][refresh] user not found for refresh token", { userId: payload.userId });
      return NextResponse.json(
        { error: "User not found" },
        { status: 401 },
      );
    }

    // Rotate with the reuse-grace window (ADR-031): wins the rotation normally,
    // graces a benign concurrent/retry refresh presented within the window, or
    // reports reuse (consumed outside the window / unknown token).
    const rotation = await rotateRefreshToken(
      token,
      { id: user.id, displayName: user.displayName, role: user.role },
      request,
    );

    if (rotation.kind === "reuse") {
      // Reuse of a token consumed outside the grace window (possible theft):
      // revoke the whole family — force re-login everywhere.
      console.warn("[engram][refresh] refresh token reuse outside grace window; revoking session family", { userId: payload.userId });
      await revokeTokenFamily(payload.userId, request);
      return NextResponse.json(
        { error: "Session expired" },
        { status: 401 },
      );
    }

    const { accessToken, refreshToken } = rotation;

    // Build response with cookies. Body-based refresh is the native-client
    // transport, so it needs the rotated refresh token in the JSON response.
    const response = NextResponse.json(
      tokenSource === "body"
        ? { accessToken, refreshToken, tokenType: "Bearer", expiresIn: 15 * 60 }
        : { accessToken },
    );

    response.cookies.set(ACCESS_COOKIE_NAME, accessToken, ACCESS_COOKIE_OPTIONS);
    response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);

    console.info("[engram][refresh] refresh succeeded", { userId: user.id, graced: rotation.kind === "graced" });

    return response;
  } catch (error) {
    console.error("Refresh request failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
