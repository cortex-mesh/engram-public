import { NextResponse, type NextRequest } from "next/server";
import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { isOrgManager } from "@/lib/authorization";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";
import { prisma } from "@/lib/prisma";

export interface OrgAdminAuth {
  userId: string;
  role: string;
  superadmin: boolean;
  /** The caller's org role in the target org; null for superadmins (they bypass membership). */
  orgRole: string | null;
}

type GuardResult =
  | { ok: true; auth: OrgAdminAuth }
  | { ok: false; response: NextResponse };

interface GuardOptions {
  orgId: string;
  /** mutation = true enables the cross-origin cookie write check. */
  mutation: boolean;
}

/**
 * Authorize a request that wants to read or mutate member/invite/audit data
 * for an org. Permitted callers (per ADR-020):
 *
 *  - platform SUPERADMIN — any org
 *  - org OWNER or ADMIN — only for their own `:orgId`
 *
 * MEMBERs and unauthenticated callers are rejected.
 *
 * Bearer callers (Nexus backend proxy) are accepted for both reads and mutations
 * because they carry no cookie and therefore cannot be CSRF-driven cross-site.
 */
export async function authorizeOrgAdminRequest(
  request: NextRequest,
  options: GuardOptions,
): Promise<GuardResult> {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (auth.userId === "internal") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Internal API key auth is not allowed for organization management." },
        { status: 403 },
      ),
    };
  }

  if (options.mutation && hasCrossOriginCookieWrite(request)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Cross-origin cookie-authenticated writes are not allowed." },
        { status: 403 },
      ),
    };
  }

  // Re-read platform role from DB (not JWT claim) to catch revocation within
  // the 15-minute token window (security audit 2026-06-10, audit §9).
  if (await isCurrentPlatformSuperadmin(auth)) {
    return {
      ok: true,
      auth: { userId: auth.userId, role: auth.role, superadmin: true, orgRole: null },
    };
  }

  const membership = await prisma.orgMember.findFirst({
    where: { orgId: options.orgId, userId: auth.userId },
    select: { role: true },
  });

  if (membership && isOrgManager(membership.role)) {
    return {
      ok: true,
      auth: {
        userId: auth.userId,
        role: auth.role,
        superadmin: false,
        orgRole: membership.role,
      },
    };
  }

  return {
    ok: false,
    response: NextResponse.json(
      { error: "Only platform superadmins or org owners/admins can access this resource." },
      { status: 403 },
    ),
  };
}

/**
 * Returns 403 if a non-OWNER/non-superadmin caller tries to grant the OWNER role.
 * Only OWNERs and SUPERADMINs can elevate someone to OWNER (prevents privilege
 * escalation by an ADMIN bootstrapping a second OWNER).
 */
export function guardOwnerRoleEscalation(
  requestedRole: string,
  auth: OrgAdminAuth,
): NextResponse | null {
  if (requestedRole !== "OWNER") return null;
  if (auth.superadmin || auth.orgRole === "OWNER") return null;
  return NextResponse.json(
    { error: "Only org owners or platform superadmins can assign the OWNER role." },
    { status: 403 },
  );
}
