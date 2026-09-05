import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { ORG_ROLES, type OrgRole } from "@/lib/authorization";
import { hasCrossOriginCookieWrite, isUniqueConstraintError } from "@/lib/organizations";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";

const DISPLAY_NAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 254;
const USERNAME_MAX_LENGTH = 32;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function forbiddenResponse() {
  return NextResponse.json(
    { error: "Only platform superadmins can manage users." },
    { status: 403 },
  );
}

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

function normalizeUsernameCandidate(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  return normalized || "user";
}

async function generateUniqueUsername(email: string): Promise<string> {
  const localPart = email.split("@")[0] || "user";
  const baseUsername = normalizeUsernameCandidate(localPart).slice(0, USERNAME_MAX_LENGTH) || "user";

  let attempt = 0;
  while (attempt < 100) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const maxBaseLength = USERNAME_MAX_LENGTH - suffix.length;
    const username = `${baseUsername.slice(0, Math.max(maxBaseLength, 1))}${suffix}`;
    const existingUser = await prisma.user.findFirst({
      where: { username },
      select: { id: true },
    });

    if (!existingUser) {
      return username;
    }

    attempt += 1;
  }

  throw new Error("Failed to generate a unique username.");
}

function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

function toAdminUser(user: {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  role: string;
  createdAt: Date;
  orgMembers: Array<{
    role: string;
    org: {
      id: string;
      name: string;
      slug: string;
    };
  }>;
}) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    organizations: user.orgMembers
      .map((membership) => ({
        id: membership.org.id,
        name: membership.org.name,
        slug: membership.org.slug,
        role: membership.role,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    createdAt: user.createdAt.toISOString(),
  };
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (auth.userId === "internal") {
    return NextResponse.json(
      { error: "Internal API key auth is not allowed for user management." },
      { status: 403 },
    );
  }

  if (hasCrossOriginCookieWrite(request)) {
    return NextResponse.json(
      { error: "Cross-origin cookie-authenticated writes are not allowed." },
      { status: 403 },
    );
  }

  if (!(await isCurrentPlatformSuperadmin(auth))) {
    return forbiddenResponse();
  }

  let body: {
    email?: unknown;
    displayName?: unknown;
    orgId?: unknown;
    orgRole?: unknown;
  };

  try {
    body = (await request.json()) as {
      email?: unknown;
      displayName?: unknown;
      orgId?: unknown;
      orgRole?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const orgRole = body.orgRole;
  const wantsMembership = Boolean(orgId || orgRole);

  if (
    !email ||
    !EMAIL_REGEX.test(email) ||
    email.length > EMAIL_MAX_LENGTH ||
    !displayName ||
    displayName.length > DISPLAY_NAME_MAX_LENGTH ||
    (wantsMembership && (!orgId || !isOrgRole(orgRole)))
  ) {
    return NextResponse.json(
      {
        error:
          "User creation requires a valid email, a display name, and an optional valid organization membership.",
      },
      { status: 400 },
    );
  }

  if (orgId) {
    const organization = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true },
    });

    if (!organization) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
  }

  try {
    const username = await generateUniqueUsername(email);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    const user = await prisma.user.create({
      data: {
        email,
        username,
        displayName,
        passwordHash,
        emailVerified: true,
        role: "USER",
        orgMembers: orgId
          ? {
              create: [
                {
                  orgId,
                  role: orgRole as OrgRole,
                },
              ],
            }
          : undefined,
      },
      include: {
        orgMembers: {
          include: {
            org: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
      },
    });

    await recordAuditEvent({
      action: "admin.user.create",
      outcome: "success",
      actorUserId: auth.userId,
      actorType: "admin",
      targetType: "user",
      targetId: user.id,
      orgId: orgId ?? undefined,
      request,
    });

    return NextResponse.json(
      {
        user: toAdminUser(user),
        temporaryPassword,
      },
      { status: 201 },
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A user with that email or username already exists." },
        { status: 409 },
      );
    }

    console.error("Failed to create admin-managed user:", error);
    return NextResponse.json({ error: "Failed to create user." }, { status: 500 });
  }
}
