import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { isCurrentPlatformSuperadmin } from "@/lib/auth";
import { getOptionalPlatformAdminUrl } from "@/lib/apps";
import { verifyToken } from "@/lib/jwt";
import { getAccessTokenFromRequest } from "@/lib/server-cookies";

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.ENGRAM_ALLOWED_HOSTS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function platformAdminOrigin(): string | null {
  const raw = getOptionalPlatformAdminUrl();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const allowed = allowedHosts();
    return allowed.has(url.hostname.toLowerCase()) ? url.origin : null;
  } catch {
    return null;
  }
}

function requestHost(headerStore: Awaited<ReturnType<typeof headers>>): string | null {
  const host = firstHeaderValue(headerStore.get("x-forwarded-host")) || firstHeaderValue(headerStore.get("host"));
  return host?.split(":")[0]?.toLowerCase() || null;
}

function safeCurrentPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/admin";
  }
  return value;
}

async function redirectToCanonicalPlatformHostIfNeeded(): Promise<void> {
  const headerStore = await headers();
  const currentHost = requestHost(headerStore);
  const platformOrigin = platformAdminOrigin();
  if (!currentHost || !platformOrigin) return;

  const platformHost = new URL(platformOrigin).hostname.toLowerCase();
  const allowed = allowedHosts();
  if (currentHost === platformHost || !allowed.has(currentHost)) return;

  const currentPath = safeCurrentPath(headerStore.get("x-engram-request-path"));
  redirect(`${platformOrigin}${currentPath}`);
}

async function redirectAnonymousAdminRequest(): Promise<never> {
  const headerStore = await headers();
  const currentPath = safeCurrentPath(headerStore.get("x-engram-request-path"));
  redirect(`/api/auth/continue?redirect_uri=${encodeURIComponent(currentPath)}`);
}

export async function requireAdminPageSuperadmin(): Promise<{ userId: string }> {
  await redirectToCanonicalPlatformHostIfNeeded();

  const token = await getAccessTokenFromRequest();
  if (!token) {
    return await redirectAnonymousAdminRequest();
  }

  let userId: string | null = null;
  try {
    const payload = await verifyToken(token);
    if (payload.type === "access") {
      userId = payload.userId;
    }
  } catch {
    return await redirectAnonymousAdminRequest();
  }

  if (!userId || !(await isCurrentPlatformSuperadmin({ userId }))) {
    notFound();
  }

  return { userId };
}
