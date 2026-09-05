import { NextRequest, NextResponse } from "next/server";

import { recordAuditEvent } from "@/lib/audit";
import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";
import { prisma } from "@/lib/prisma";

function forbiddenResponse() {
  return NextResponse.json(
    { error: "Only platform superadmins can manage waitlist visibility." },
    { status: 403 },
  );
}

function isRecordNotFound(error: unknown): boolean {
  return (error as { code?: string }).code === "P2025";
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<unknown> },
) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.userId === "internal") {
    return NextResponse.json(
      { error: "Internal API key auth is not allowed for waitlist visibility." },
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

  let body: { hidden?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as { hidden?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.hidden !== "boolean") {
    return NextResponse.json({ error: "hidden must be a boolean." }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 160) : "";
  const params = await context.params;
  const id = typeof params === "object" && params !== null && "id" in params
    ? (params as { id?: unknown }).id
    : null;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json({ error: "Waitlist request not found." }, { status: 404 });
  }

  try {
    const existing = await prisma.waitlistRequest.findUnique({
      where: { id },
      select: { id: true, approvedAt: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Waitlist request not found." }, { status: 404 });
    }
    if (body.hidden && existing.approvedAt) {
      return NextResponse.json(
        { error: "Approved waitlist requests cannot be hidden." },
        { status: 409 },
      );
    }

    const waitlistRequest = await prisma.waitlistRequest.update({
      where: { id },
      data: body.hidden
        ? {
            hiddenAt: new Date(),
            hiddenByUserId: auth.userId,
            hiddenReason: reason || "Marked as test/junk from admin queue",
          }
        : {
            hiddenAt: null,
            hiddenByUserId: null,
            hiddenReason: null,
          },
      select: { id: true, email: true, clientId: true, hiddenAt: true },
    });

    await recordAuditEvent({
      action: "waitlist.hide",
      outcome: "success",
      actorUserId: auth.userId,
      actorType: "admin",
      targetType: "waitlist_request",
      targetId: waitlistRequest.id,
      reason: body.hidden ? (reason || "Marked as test/junk from admin queue") : "Unhidden from admin queue",
      metadata: {
        email: waitlistRequest.email,
        clientId: waitlistRequest.clientId,
        hidden: Boolean(waitlistRequest.hiddenAt),
      },
      request,
    });

    return NextResponse.json({
      ok: true,
      hiddenAt: waitlistRequest.hiddenAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("Waitlist visibility update failed:", error);
    if (isRecordNotFound(error)) {
      return NextResponse.json({ error: "Waitlist request not found." }, { status: 404 });
    }
    return NextResponse.json({ error: "Waitlist visibility update failed." }, { status: 500 });
  }
}
