import { NextResponse, type NextRequest } from "next/server";

import { authorizeOrgAdminRequest } from "@/lib/org-admin-auth";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { writeProviderSecret, deleteProviderSecret } from "@/lib/asm-client";
import {
  isAiProviderKey,
  providerSecretId,
  validateApiKeyFormat,
} from "@/lib/provider-credentials";

interface RouteContext {
  params: Promise<{ orgId: string; provider: string }>;
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { orgId, provider } = await context.params;

  if (!isAiProviderKey(provider)) {
    return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }

  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: true });
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null;
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

  const formatError = validateApiKeyFormat(apiKey);
  if (formatError) {
    return NextResponse.json({ error: formatError }, { status: 400 });
  }

  const last4 = apiKey.slice(-4);
  const secretId = providerSecretId(orgId, provider);
  const now = new Date();

  // DB upsert BEFORE ASM write: if the DB fails nothing is written to ASM.
  // If the DB succeeds but ASM later fails the user retries; the upsert is
  // idempotent and writeProviderSecret is idempotent (PutSecretValue overwrites).
  // We detect create-vs-update from the returned createdAt rather than a pre-check
  // findUnique to eliminate the TOCTOU race on the audit action.
  const credential = await prisma.orgProviderCredential.upsert({
    where: { orgId_provider: { orgId, provider } },
    create: {
      orgId,
      provider,
      credentialKind: "aws_secrets_manager",
      credentialRef: secretId,
      last4,
      status: "active",
      createdByUserId: guard.auth.userId,
      rotatedAt: now,
    },
    update: {
      credentialRef: secretId,
      last4,
      status: "active",
      rotatedAt: now,
    },
    select: {
      provider: true,
      status: true,
      last4: true,
      rotatedAt: true,
      updatedAt: true,
      createdAt: true,
    },
  });

  // On create, Prisma sets both createdAt (DB default now()) and updatedAt
  // (@updatedAt) in the same write, so they are equal (or within ~1 ms).
  // On update, createdAt is unchanged while updatedAt is reset to now.
  const isNew = Math.abs(credential.createdAt.getTime() - credential.updatedAt.getTime()) < 100;

  await writeProviderSecret(secretId, apiKey);

  await recordAuditEvent({
    action: isNew ? "org.provider_credential.set" : "org.provider_credential.rotate",
    outcome: "success",
    actorUserId: guard.auth.userId,
    actorType: guard.auth.superadmin ? "admin" : "org_admin",
    targetType: "org_provider_credential",
    targetId: `${orgId}:${provider}`,
    orgId,
    metadata: { provider, last4 },
    request,
  });

  return NextResponse.json({
    credential: {
      provider: credential.provider,
      status: credential.status,
      last4: credential.last4,
      rotatedAt: credential.rotatedAt,
      updatedAt: credential.updatedAt,
    },
  });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { orgId, provider } = await context.params;

  if (!isAiProviderKey(provider)) {
    return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }

  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: true });
  if (!guard.ok) return guard.response;

  const existing = await prisma.orgProviderCredential.findUnique({
    where: { orgId_provider: { orgId, provider } },
    select: { id: true, credentialRef: true },
  });

  if (!existing) {
    return NextResponse.json(
      { error: `No credential configured for provider: ${provider}` },
      { status: 404 },
    );
  }

  // DB row deleted FIRST so the credential is immediately de-listed from the
  // system (no resolver can pick it up) even if the ASM delete is delayed.
  // ASM delete soft-fails: if it throws we log a warning but return success —
  // the secret is now orphaned in ASM (no DB ref → inaccessible to the mesh)
  // and can be cleaned up by an operator using the runbook.
  await prisma.orgProviderCredential.delete({
    where: { orgId_provider: { orgId, provider } },
  });

  try {
    await deleteProviderSecret(existing.credentialRef);
  } catch (err) {
    console.warn("[engram][asm] ASM delete failed for", existing.credentialRef, err);
  }

  await recordAuditEvent({
    action: "org.provider_credential.delete",
    outcome: "success",
    actorUserId: guard.auth.userId,
    actorType: guard.auth.superadmin ? "admin" : "org_admin",
    targetType: "org_provider_credential",
    targetId: `${orgId}:${provider}`,
    orgId,
    metadata: { provider },
    request,
  });

  return NextResponse.json({ success: true });
}
