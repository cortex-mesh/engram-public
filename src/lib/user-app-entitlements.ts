import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import {
  isOrgManager,
  type AppKey,
} from "@/lib/authorization";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";
import { prisma } from "@/lib/prisma";

export interface UserOverrideAuth {
  userId: string;
  role: string | null;
  superadmin: boolean;
}

type GuardResult =
  | { ok: true; auth: UserOverrideAuth }
  | { ok: false; response: NextResponse };

interface GuardOptions {
  orgId: string;
  // mutation = true requires the cross-origin cookie write check.
  mutation: boolean;
}

/**
 * Authorize a request that wants to read or mutate per-user app
 * entitlements for an org. Permitted callers (per ADR-009 D3):
 *
 *  - platform SUPERADMIN — any org, any app
 *  - org OWNER or ADMIN — only for `:orgId`, only for apps the org is
 *    already entitled to (caller checks the per-app gate after this)
 *
 * MEMBERs and unauthenticated callers are rejected here.
 */
export async function authorizeUserAppEntitlementRequest(
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
        {
          error:
            "Internal API key auth is not allowed for organization management.",
        },
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

  // Re-read the platform role from the DB, not the JWT claim (audit #9).
  if (await isCurrentPlatformSuperadmin(auth)) {
    return {
      ok: true,
      auth: { userId: auth.userId, role: auth.role, superadmin: true },
    };
  }

  const membership = await prisma.orgMember.findFirst({
    where: { orgId: options.orgId, userId: auth.userId },
    select: { role: true },
  });

  if (membership && isOrgManager(membership.role)) {
    return {
      ok: true,
      auth: { userId: auth.userId, role: auth.role, superadmin: false },
    };
  }

  return {
    ok: false,
    response: NextResponse.json(
      {
        error:
          "Only platform superadmins or org owners/admins can manage user app entitlements.",
      },
      { status: 403 },
    ),
  };
}

/**
 * A per-user app entitlement override is only meaningful for a user who is
 * a member of the org — the override gates an app *within that org*. The
 * routes previously checked only that the target user existed globally,
 * which let an org owner/admin (or superadmin) write override rows scoped
 * to `orgId` for users in *other* orgs, breaking tenant isolation and
 * polluting authorization state (security audit 2026-06-10, HG-1).
 *
 * This is enforced for ALL callers, superadmin included: a row for a
 * non-member is invalid data no matter who creates it. Returns 404 (not
 * 403) for non-members so the endpoint can't be used to probe which users
 * belong to which org.
 */
export async function ensureTargetIsOrgMember(opts: {
  orgId: string;
  userId: string;
}): Promise<NextResponse | null> {
  const membership = await prisma.orgMember.findUnique({
    where: { userId_orgId: { userId: opts.userId, orgId: opts.orgId } },
    select: { id: true },
  });

  if (!membership) {
    return NextResponse.json(
      { error: "User is not a member of this organization." },
      { status: 404 },
    );
  }

  return null;
}

/**
 * For OWNER/ADMIN callers, the org must have the app enabled before they
 * can manage per-user overrides (or, per ADR-030 D5, the app's access mode)
 * for it. SUPERADMIN bypasses (per the standing project memory: "SUPERADMIN
 * bypasses all access controls").
 */
export async function ensureOrgHasAppEntitled(opts: {
  orgId: string;
  appKey: AppKey;
  superadmin: boolean;
  errorMessage?: string;
}): Promise<NextResponse | null> {
  if (opts.superadmin) return null;

  const orgEntitlement = await prisma.orgAppEntitlement.findUnique({
    where: { orgId_appKey: { orgId: opts.orgId, appKey: opts.appKey } },
    select: { enabled: true },
  });

  if (!orgEntitlement || !orgEntitlement.enabled) {
    return NextResponse.json(
      {
        error:
          opts.errorMessage ||
          "Organization owners and admins can only manage per-user overrides for apps the org has enabled.",
      },
      { status: 400 },
    );
  }

  return null;
}
