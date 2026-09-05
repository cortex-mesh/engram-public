import { prisma } from "@/lib/prisma";
import { nanoid } from "nanoid";
import { sha256 } from "@/lib/crypto";

const MAGIC_LINK_TTL_MINUTES = 15;

export type MagicLinkPurpose = "login" | "set_password" | "verify_email";

// Create a magic link for a user. `purpose` binds the link to a flow so a
// login link can't be replayed across credential flows (ADR-017 / ADR-025).
export async function createMagicLink(
  userId: string,
  purpose: MagicLinkPurpose = "login",
): Promise<{ token: string; expiresAt: Date }> {
  const token = nanoid(48);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000);

  await prisma.magicLink.create({
    data: { userId, token: tokenHash, purpose, expiresAt },
  });

  return { token, expiresAt }; // Return the raw token for the email
}

// Verify and consume a magic link (single-use, atomic). Only consumed when
// its purpose matches the expected one.
export async function consumeMagicLink(
  token: string,
  expectedPurpose: MagicLinkPurpose = "login",
): Promise<{ valid: boolean; userId?: string; reason?: string }> {
  const now = new Date();
  const tokenHash = sha256(token);

  // Atomic: update only if not used, not expired, and the purpose matches
  const result = await prisma.magicLink.updateMany({
    where: {
      token: tokenHash,
      usedAt: null,
      expiresAt: { gt: now },
      purpose: expectedPurpose,
    },
    data: { usedAt: now },
  });

  if (result.count === 0) {
    // Determine the reason
    const link = await prisma.magicLink.findUnique({ where: { token: tokenHash } });
    if (!link) return { valid: false, reason: "not_found" };
    if (link.usedAt) return { valid: false, reason: "already_used" };
    if (link.expiresAt < now) return { valid: false, reason: "expired" };
    return { valid: false, reason: "unknown" };
  }

  // Fetch the link to get userId
  const link = await prisma.magicLink.findUnique({ where: { token: tokenHash } });
  return { valid: true, userId: link?.userId };
}

// Clean up expired magic links (housekeeping)
export async function cleanupExpiredMagicLinks(): Promise<number> {
  const result = await prisma.magicLink.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { usedAt: { not: null } },
      ],
    },
  });
  return result.count;
}
