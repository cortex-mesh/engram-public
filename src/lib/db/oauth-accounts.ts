import { prisma } from "@/lib/prisma";
import { generateUniqueUsername } from "@/lib/usernames";

export async function findOAuthAccount(provider: string, providerAccountId: string) {
  return prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    include: { user: true },
  });
}

export async function linkOAuthAccount(userId: string, provider: string, providerAccountId: string) {
  return prisma.oAuthAccount.create({
    data: { userId, provider, providerAccountId },
  });
}

// Find an existing user from OAuth data, linking the provider account when possible.
// Self-service account creation is disabled, so unknown OAuth users must join the waitlist.
export async function findOrCreateOAuthUser(data: {
  provider: string;
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl?: string;
  allowCreate?: boolean;
}): Promise<{ user: Record<string, unknown>; isNewUser: boolean } | null> {
  // 1. Check if OAuth account already linked
  const existing = await findOAuthAccount(data.provider, data.providerAccountId);
  if (existing) {
    return { user: existing.user, isNewUser: false };
  }

  // 2. Link to an existing local user by email — ONLY when the provider has
  // VERIFIED the email. Linking on an unverified provider email is an
  // account-takeover vector: an attacker controlling an OAuth identity that
  // merely *claims* the victim's address would otherwise be merged into the
  // victim's account (audit 2026-06-10, #6).
  if (data.email && data.emailVerified) {
    const normalizedEmail = data.email.toLowerCase();
    const emailUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (emailUser) {
      await linkOAuthAccount(emailUser.id, data.provider, data.providerAccountId);
      // Provider confirmed the email, so it's safe to fill avatar / mark verified.
      const updates: Record<string, unknown> = {};
      if (!emailUser.avatarUrl && data.avatarUrl) updates.avatarUrl = data.avatarUrl;
      if (!emailUser.emailVerified) updates.emailVerified = true;
      if (Object.keys(updates).length > 0) {
        await prisma.user.update({ where: { id: emailUser.id }, data: updates });
      }
      return { user: emailUser, isNewUser: false };
    }

    if (data.allowCreate) {
      const user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          username: await generateUniqueUsername(normalizedEmail),
          displayName: data.displayName,
          avatarUrl: data.avatarUrl,
          emailVerified: true,
          role: "USER",
          oauthAccounts: {
            create: {
              provider: data.provider,
              providerAccountId: data.providerAccountId,
            },
          },
        },
      });
      return { user, isNewUser: true };
    }
  }

  return null;
}
