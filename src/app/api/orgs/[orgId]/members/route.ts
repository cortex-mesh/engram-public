import { NextResponse, type NextRequest } from "next/server";

import { ORG_ROLES, isPlatformSuperadmin, type OrgRole } from "@/lib/authorization";
import { isUniqueConstraintError } from "@/lib/organizations";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { authorizeOrgAdminRequest, guardOwnerRoleEscalation } from "@/lib/org-admin-auth";

interface RouteContext {
  params: Promise<{ orgId: string }>;
}

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

function immutableSuperadminResponse() {
  return NextResponse.json(
    { error: "Platform superadmins always retain implicit org access and should not be added explicitly." },
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

export async function GET(request: NextRequest, context: RouteContext) {
  const { orgId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: false });
  if (!guard.ok) return guard.response;

  const members = await prisma.orgMember.findMany({
    where: { orgId },
    orderBy: { createdAt: "asc" },
    include: {
      user: {
        select: { id: true, email: true, username: true, displayName: true, role: true },
      },
    },
  });

  return NextResponse.json({
    members: members.map((m) => toMemberResponse(m, guard.auth.superadmin)),
  });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { orgId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: true });
  if (!guard.ok) return guard.response;

  const body = (await request.json()) as { email?: unknown; role?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@") || !isOrgRole(body.role)) {
    return NextResponse.json(
      { error: "Member management requires a valid email and org role." },
      { status: 400 },
    );
  }

  const escalation = guardOwnerRoleEscalation(body.role, guard.auth);
  if (escalation) return escalation;

  const organization = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!organization) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true, email: true, username: true, displayName: true, role: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  if (isPlatformSuperadmin(user.role)) {
    return immutableSuperadminResponse();
  }

  try {
    const member = await prisma.orgMember.create({
      data: { orgId, userId: user.id, role: body.role },
      include: {
        user: {
          select: { id: true, email: true, username: true, displayName: true, role: true },
        },
      },
    });

    await recordAuditEvent({
      action: "org.member.add",
      outcome: "success",
      actorUserId: guard.auth.userId,
      actorType: guard.auth.superadmin ? "admin" : "org_admin",
      targetType: "user",
      targetId: user.id,
      orgId,
      metadata: { role: body.role },
      request,
    });

    return NextResponse.json({ member: toMemberResponse(member, guard.auth.superadmin) }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "User is already a member of this organization." }, { status: 409 });
    }
    console.error("Failed to add organization member:", error);
    return NextResponse.json({ error: "Failed to add organization member." }, { status: 500 });
  }
}
