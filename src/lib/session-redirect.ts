import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/jwt";
import { getDefaultPostLoginTarget } from "@/lib/apps";

/**
 * Resolves the post-login redirect target for a given access token.
 * Returns null when the token is absent or invalid (caller should redirect to /login).
 * Never calls redirect() itself — safe to use where redirect() must be called
 * outside a try/catch (Next's redirect() throws NEXT_REDIRECT internally).
 */
export async function resolvePostLoginTarget(
  accessToken: string | undefined,
): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const payload = await verifyToken(accessToken);
    if (!payload || payload.type !== "access") return null;
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        lastOrgId: true,
        orgMembers: {
          orderBy: { createdAt: "asc" },
          include: {
            org: {
              select: { id: true, slug: true },
            },
          },
        },
      },
    });
    return getDefaultPostLoginTarget({
      role: payload.role,
      orgMemberships: user?.orgMembers,
      lastOrgId: user?.lastOrgId,
    });
  } catch {
    return null;
  }
}
