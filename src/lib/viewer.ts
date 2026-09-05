import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/jwt";

export interface Viewer {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  oauthProviders: string[];
  hasPassword: boolean;
}

export async function getCurrentUserFromAccessToken(
  accessToken: string | undefined,
): Promise<Viewer | null> {
  if (!accessToken) {
    return null;
  }

  try {
    const payload = await verifyToken(accessToken);
    if (!payload || payload.type !== "access") {
      return null;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { oauthAccounts: true },
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role,
      emailVerified: user.emailVerified,
      avatarUrl: user.avatarUrl,
      oauthProviders: user.oauthAccounts.map((account) => account.provider),
      hasPassword: !!user.passwordHash,
    };
  } catch {
    return null;
  }
}
