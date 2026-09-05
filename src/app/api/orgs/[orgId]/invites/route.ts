import { NextResponse, type NextRequest } from "next/server";

import { ORG_ROLES, type OrgRole } from "@/lib/authorization";
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

function toInviteResponse(invite: {
  id: string;
  email: string;
  role: string;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    createdAt: invite.createdAt.toISOString(),
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { orgId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: false });
  if (!guard.ok) return guard.response;

  const invites = await prisma.orgInvite.findMany({
    where: { orgId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, createdAt: true, acceptedAt: true, revokedAt: true },
  });

  return NextResponse.json({ invites: invites.map(toInviteResponse) });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { orgId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: true });
  if (!guard.ok) return guard.response;

  const body = (await request.json()) as { email?: unknown; role?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@") || !isOrgRole(body.role)) {
    return NextResponse.json(
      { error: "Invite management requires a valid email and org role." },
      { status: 400 },
    );
  }

  const escalation = guardOwnerRoleEscalation(body.role, guard.auth);
  if (escalation) return escalation;

  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true },
  });
  if (!organization) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const existingInvite = await prisma.orgInvite.findFirst({
    where: { orgId, email, acceptedAt: null, revokedAt: null },
    select: { id: true },
  });
  if (existingInvite) {
    return NextResponse.json(
      { error: "A pending invite for this email already exists." },
      { status: 409 },
    );
  }

  try {
    const invite = await prisma.orgInvite.create({
      data: { orgId, email, role: body.role, invitedByUserId: guard.auth.userId },
      select: { id: true, email: true, role: true, createdAt: true, acceptedAt: true, revokedAt: true },
    });

    await recordAuditEvent({
      action: "org.invite.create",
      outcome: "success",
      actorUserId: guard.auth.userId,
      actorType: guard.auth.superadmin ? "admin" : "org_admin",
      targetType: "invite",
      targetId: invite.id,
      orgId,
      metadata: { email, role: body.role },
      request,
    });

    return NextResponse.json({ invite: toInviteResponse(invite) }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A pending invite for this email already exists." },
        { status: 409 },
      );
    }
    console.error("Failed to create organization invite:", error);
    return NextResponse.json({ error: "Failed to create organization invite." }, { status: 500 });
  }
}
