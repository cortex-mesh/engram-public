import { NextResponse, type NextRequest } from "next/server";

import { ORG_ROLES, isPlatformSuperadmin, isOrgManager, isOrgOwner, type OrgRole } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { authorizeOrgAdminRequest, guardOwnerRoleEscalation } from "@/lib/org-admin-auth";
import type { OrgAdminAuth } from "@/lib/org-admin-auth";

interface RouteContext {
  params: Promise<{ orgId: string; userId: string }>;
}

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

function immutableSuperadminResponse() {
  return NextResponse.json(
    { error: "Platform superadmins always retain implicit org access and cannot be changed here." },
    { status: 400 },
  );
}

function toMemberResponse(
  member: {
    role: string;
    createdAt: Date;
    user: { id: string; email: string; username: string; displayName: string | null; role: string };
  },
  superadmin: boolean,
) {
  return {
    id: member.user.id,
    username: member.user.username,
    displayName: member.user.displayName || member.user.username,
    ...(superadmin ? { email: member.user.email } : {}),
    platformRole: member.user.role,
    orgRole: member.role,
    joinedAt: member.createdAt.toISOString(),
  };
}

/**
 * Ensure the org keeps at least one manager (OWNER or ADMIN) and, if the
 * operation would remove or demote an OWNER, that at least one OWNER remains.
 *
 * `currentRole` — the target member's current role.
 * `nextRole`    — the role they will have after the operation (undefined = DELETE).
 */
async function ensureManagerInvariant(orgId: string, currentRole: string, nextRole?: string) {
  if (!isOrgManager(currentRole)) return null;

  // When a manager is being removed from all manager roles, ensure ≥1 manager survives.
  if (!nextRole || !isOrgManager(nextRole)) {
    const managerCount = await prisma.orgMember.count({
      where: { orgId, role: { in: ["OWNER", "ADMIN"] } },
    });
    if (managerCount <= 1) {
      return NextResponse.json(
        { error: "An organization must keep at least one owner or admin." },
        { status: 400 },
      );
    }
  }

  // When an OWNER is being removed or demoted to any non-OWNER role (including ADMIN),
  // ensure at least one other OWNER remains. Without this guard, all OWNERs could be
  // stripped while ADMINs remain — leaving the org in an unrecoverable state because
  // ADMINs cannot assign the OWNER role.
  if (isOrgOwner(currentRole) && !isOrgOwner(nextRole)) {
    const ownerCount = await prisma.orgMember.count({
      where: { orgId, role: "OWNER" },
    });
    if (ownerCount <= 1) {
      return NextResponse.json(
        { error: "An organization must keep at least one owner." },
        { status: 400 },
      );
    }
  }

  return null;
}

/** Block a non-OWNER/non-SUPERADMIN caller from modifying a target whose current role is OWNER. */
function guardOwnerTargetModification(targetRole: string, auth: OrgAdminAuth): NextResponse | null {
  if (targetRole !== "OWNER") return null;
  if (auth.superadmin || auth.orgRole === "OWNER") return null;
  return NextResponse.json(
    { error: "Only org owners or platform superadmins can modify or remove an owner." },
    { status: 403 },
  );
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { orgId, userId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: true });
  if (!guard.ok) return guard.response;

  const body = (await request.json()) as { role?: unknown };
  if (!isOrgRole(body.role)) {
    return NextResponse.json({ error: "Member management requires a valid org role." }, { status: 400 });
  }

  const escalation = guardOwnerRoleEscalation(body.role, guard.auth);
  if (escalation) return escalation;

  const membership = await prisma.orgMember.findFirst({
    where: { orgId, userId },
    select: { id: true, role: true, user: { select: { role: true } } },
  });
  if (!membership) {
    return NextResponse.json({ error: "Organization member not found." }, { status: 404 });
  }

  if (isPlatformSuperadmin(membership.user.role)) {
    return immutableSuperadminResponse();
  }

  const ownerGuard = guardOwnerTargetModification(membership.role, guard.auth);
  if (ownerGuard) return ownerGuard;

  const invariantError = await ensureManagerInvariant(orgId, membership.role, body.role);
  if (invariantError) return invariantError;

  const member = await prisma.orgMember.update({
    where: { id: membership.id, orgId },
    data: { role: body.role },
    include: {
      user: {
        select: { id: true, email: true, username: true, displayName: true, role: true },
      },
    },
  });

  await recordAuditEvent({
    action: "org.member.role_change",
    outcome: "success",
    actorUserId: guard.auth.userId,
    actorType: guard.auth.superadmin ? "admin" : "org_admin",
    targetType: "user",
    targetId: userId,
    orgId,
    metadata: { from: membership.role, to: body.role },
    request,
  });

  return NextResponse.json({ member: toMemberResponse(member, guard.auth.superadmin) });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { orgId, userId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: true });
  if (!guard.ok) return guard.response;

  const membership = await prisma.orgMember.findFirst({
    where: { orgId, userId },
    select: { role: true, user: { select: { role: true } } },
  });
  if (!membership) {
    return NextResponse.json({ error: "Organization member not found." }, { status: 404 });
  }

  if (isPlatformSuperadmin(membership.user.role)) {
    return immutableSuperadminResponse();
  }

  const ownerGuard = guardOwnerTargetModification(membership.role, guard.auth);
  if (ownerGuard) return ownerGuard;

  const invariantError = await ensureManagerInvariant(orgId, membership.role);
  if (invariantError) return invariantError;

  // Remove membership AND per-org app-entitlement overrides atomically.
  // An override scoped to (user, org) is meaningless once the user leaves;
  // keeping it would violate the "override implies membership" invariant
  // (security audit 2026-06-10, HG-1).
  await prisma.$transaction([
    prisma.userAppEntitlement.deleteMany({ where: { orgId, userId } }),
    prisma.orgMember.deleteMany({ where: { orgId, userId } }),
  ]);

  await recordAuditEvent({
    action: "org.member.remove",
    outcome: "success",
    actorUserId: guard.auth.userId,
    actorType: guard.auth.superadmin ? "admin" : "org_admin",
    targetType: "user",
    targetId: userId,
    orgId,
    request,
  });

  return NextResponse.json({ success: true });
}
