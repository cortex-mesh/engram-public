import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateTokenPair } from "@/lib/jwt";
import { sha256, encryptSecret, decryptSecret } from "@/lib/crypto";
import { recordAuditEvent } from "@/lib/audit";

/**
 * Reuse-grace window (ADR-031). A refresh token rotated within this window is
 * treated as a benign concurrent/retry refresh — the caller gets the SAME
 * successor the winning rotation issued (idempotent, one chain), instead of the
 * whole token family being revoked. Reuse of a token consumed *outside* this
 * window (or an unknown token) still revokes.
 */
export const REFRESH_GRACE_WINDOW_MS = 30_000;

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type RotationUser = Parameters<typeof generateTokenPair>[0];

export type RefreshRotationResult =
  | { kind: "rotated"; accessToken: string; refreshToken: string }
  | { kind: "graced"; accessToken: string; refreshToken: string }
  | { kind: "reuse" };

/**
 * Rotate a presented refresh token for `user`, atomically and single-winner
 * (ADR-001 / audit #7), with the ADR-031 reuse-grace window.
 *
 * - `rotated` — this caller won the rotation; issue the returned pair.
 * - `graced`  — this caller lost the race but the token was consumed within the
 *               grace window; issue the winning rotation's successor refresh
 *               token (decrypted) paired with a fresh access token, so all
 *               concurrent/retry callers converge on ONE chain (no parallel
 *               session).
 * - `reuse`   — the token was consumed outside the window, has no recoverable
 *               successor, or is unknown; the caller must revoke the family
 *               (theft signal) via `revokeTokenFamily`.
 *
 * Raw tokens are never persisted — only SHA-256 hashes and the AES-GCM-encrypted
 * successor (recoverable only within the grace window, then swept).
 */
export async function rotateRefreshToken(
  presentedToken: string,
  user: RotationUser,
  request?: NextRequest,
): Promise<RefreshRotationResult> {
  const tokenHash = sha256(presentedToken);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  // Mint the candidate pair up front — pure CPU, no DB side effect, safe to
  // discard if we neither win nor grace.
  const candidate = await generateTokenPair(user);

  // Atomic single-winner rotation: flip consumedAt null -> now for this exact
  // token and record the encrypted successor, together with creating the
  // successor row. Under concurrent refreshes exactly one caller matches an
  // unconsumed row (count === 1) and wins.
  let won = false;
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.refreshToken.updateMany({
      where: { tokenHash, consumedAt: null },
      data: { consumedAt: new Date(), replacement: encryptSecret(candidate.refreshToken) },
    });
    if (consumed.count !== 1) return; // lost the race, or already consumed
    await tx.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(candidate.refreshToken), expiresAt },
    });
    won = true;
  });

  if (won) {
    // Sweep this user's consumed rows once they're past the grace window, so
    // "row present" and "graceable" coincide — a consumed row that still exists
    // is always within grace, avoiding a dead band where a benign retry finds a
    // present-but-ungraceable row and is mis-classified as reuse. A row is only
    // ever gone once it is genuinely stale (or was explicitly revoked).
    //
    // Non-fatal: the rotation has already committed and the caller must get its
    // new tokens — a transient failure of this opportunistic cleanup must not
    // turn a successful refresh into a 500 (the row is re-swept on the next one).
    try {
      await prisma.refreshToken.deleteMany({
        where: { userId: user.id, consumedAt: { lt: new Date(Date.now() - REFRESH_GRACE_WINDOW_MS) } },
      });
    } catch (error) {
      console.warn("[engram][refresh] consumed-token sweep failed (non-fatal)", { userId: user.id, error });
    }
    return { kind: "rotated", accessToken: candidate.accessToken, refreshToken: candidate.refreshToken };
  }

  // We didn't win. Grace the token if it was consumed within the window and its
  // successor is still recoverable. Re-read the clock *now* (not at entry) so a
  // slow/contended rotation can't stretch the effective window.
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (existing?.consumedAt && existing.replacement && Date.now() - existing.consumedAt.getTime() <= REFRESH_GRACE_WINDOW_MS) {
    const successorRefresh = decryptSecret(existing.replacement);
    if (successorRefresh) {
      // Telemetry: a within-grace re-presentation. Benign in the common case,
      // but a burst for one user is a signal worth monitoring.
      await recordAuditEvent({
        action: "refresh.reuse_graced",
        outcome: "success",
        actorUserId: user.id,
        targetType: "user",
        targetId: user.id,
        reason: "refresh_token_reuse_within_grace_window",
        request,
      });
      // Idempotent: return the winning rotation's successor (same for every
      // within-grace caller) paired with this caller's fresh access token.
      return { kind: "graced", accessToken: candidate.accessToken, refreshToken: successorRefresh };
    }
  }

  return { kind: "reuse" };
}

/**
 * Revoke a user's entire refresh-token family (theft response) and record the
 * reuse audit event. Shared by both rotation call sites so the browser-SSO path
 * and the JSON/native path stay identical (ADR-031 fixes the previously
 * audit-less continue path).
 */
export async function revokeTokenFamily(userId: string, request?: NextRequest): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await recordAuditEvent({
    action: "refresh.reuse_detected",
    outcome: "failure",
    actorUserId: userId,
    targetType: "user",
    targetId: userId,
    reason: "refresh_token_reuse_session_family_revoked",
    request,
  });
}
