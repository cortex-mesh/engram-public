import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";
import {
  findRegisteredNativeClient,
  issueNativeAuthorizationCode,
  isValidNativeClientId,
  normalizeNativeRedirectUri,
  validateNativeAppKey,
  validateNativeAuthorizationAdmission,
  validateNativeTenantSlug,
  validatePkceCodeChallenge,
} from "@/lib/native-auth";
import { prisma } from "@/lib/prisma";

const EMAIL_MAX_LENGTH = 254;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fixtureUnavailable() {
  return NextResponse.json(
    { error: "Native auth-code fixture is not available." },
    { status: 404 },
  );
}

function fixtureEnabled(): boolean {
  return process.env.ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE === "1";
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

function callbackUrl({
  redirectUri,
  code,
  state,
}: {
  redirectUri: string;
  code: string;
  state: string;
}): string {
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) {
    target.searchParams.set("state", state);
  }
  return target.toString();
}

export async function POST(request: NextRequest) {
  if (!fixtureEnabled()) {
    return fixtureUnavailable();
  }

  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (auth.userId === "internal") {
    return NextResponse.json(
      { error: "Internal API key auth is not allowed for native auth fixtures." },
      { status: 403 },
    );
  }

  if (!(await isCurrentPlatformSuperadmin(auth))) {
    return NextResponse.json(
      { error: "Only platform superadmins can issue native auth fixture codes." },
      { status: 403 },
    );
  }

  if (hasCrossOriginCookieWrite(request)) {
    return NextResponse.json(
      { error: "Cross-origin cookie-authenticated writes are not allowed." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const clientId = field(body, "clientId");
  const redirectUri = normalizeNativeRedirectUri(body.redirectUri);
  const tenantSlug = validateNativeTenantSlug(body.tenant);
  const appKey = validateNativeAppKey(body.app);
  const codeChallenge = validatePkceCodeChallenge(body.codeChallenge);
  const state = field(body, "state");
  const userId = field(body, "userId");
  const userEmail = field(body, "userEmail").toLowerCase();

  if (
    !isValidNativeClientId(clientId) ||
    !redirectUri ||
    !tenantSlug ||
    !appKey ||
    !codeChallenge ||
    (!userId && (!userEmail || !EMAIL_REGEX.test(userEmail) || userEmail.length > EMAIL_MAX_LENGTH))
  ) {
    return NextResponse.json(
      {
        error:
          "Native auth-code fixture requires clientId, redirectUri, tenant, app, codeChallenge, and userId or userEmail.",
      },
      { status: 400 },
    );
  }

  const client = await findRegisteredNativeClient(clientId, redirectUri);
  if (!client) {
    return NextResponse.json(
      { error: "Native client and redirect URI are not registered." },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: userId ? { id: userId } : { email: userEmail },
    select: { id: true, email: true },
  });

  if (!user) {
    return NextResponse.json(
      { error: "No approved user exists for the requested fixture." },
      { status: 404 },
    );
  }

  const admission = await validateNativeAuthorizationAdmission({
    clientId: client.clientId,
    userId: user.id,
    tenantSlug,
    appKey,
  });

  if (!admission.allowed) {
    return NextResponse.json(
      { error: "Native authorization is not allowed for this user, tenant, and app." },
      { status: 403 },
    );
  }

  const code = await issueNativeAuthorizationCode({
    clientId: client.clientId,
    userId: user.id,
    redirectUri,
    codeChallenge,
  });

  return NextResponse.json(
    {
      callbackUrl: callbackUrl({ redirectUri, code, state }),
      clientId: client.clientId,
      redirectUri,
      tenant: tenantSlug,
      app: appKey,
      userId: user.id,
      expiresIn: 5 * 60,
    },
    {
      status: 201,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
