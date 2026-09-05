import { NextResponse, type NextRequest } from "next/server";

import { authorizeOrgAdminRequest } from "@/lib/org-admin-auth";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { readProviderSecret } from "@/lib/asm-client";
import { isAiProviderKey, testProviderKey } from "@/lib/provider-credentials";

interface RouteContext {
  params: Promise<{ orgId: string; provider: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { orgId, provider } = await context.params;

  if (!isAiProviderKey(provider)) {
    return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }

  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: true });
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null;
  const suppliedKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : null;

  let keyToTest: string;

  if (suppliedKey) {
    keyToTest = suppliedKey;
  } else {
    const stored = await prisma.orgProviderCredential.findUnique({
      where: { orgId_provider: { orgId, provider } },
      select: { credentialRef: true },
    });
    if (!stored) {
      return NextResponse.json(
        { error: `No credential configured for provider: ${provider}` },
        { status: 404 },
      );
    }
    try {
      keyToTest = await readProviderSecret(stored.credentialRef);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Failed to retrieve stored credential: ${msg}` }, { status: 503 });
    }
  }

  const result = await testProviderKey(provider, keyToTest);

  await recordAuditEvent({
    action: "org.provider_credential.test",
    outcome: result.ok ? "success" : "failure",
    actorUserId: guard.auth.userId,
    actorType: guard.auth.superadmin ? "admin" : "org_admin",
    targetType: "org_provider_credential",
    targetId: `${orgId}:${provider}`,
    orgId,
    metadata: { provider, source: suppliedKey ? "supplied" : "stored", ok: result.ok },
    request,
  });

  return NextResponse.json(result);
}
