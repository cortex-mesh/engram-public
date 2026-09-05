import { PLATFORM_APPS, getOptionalAppUrl } from "@/lib/apps";

// Startup guard (security audit 2026-06-10, HG-4): magic-link emails and
// OAuth redirect URIs embed the public origin. If ENGRAM_URL is missing in
// production, the code falls back to Host/X-Forwarded headers, which an
// attacker can control — so a production server must refuse to start
// without a valid canonical URL instead of degrading silently.
export async function register() {
  // next build prerenders in a production-env worker without runtime env;
  // only enforce when an actual server boots.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV !== "production") return;

  const raw = process.env.ENGRAM_URL?.trim();
  if (!raw) {
    throw new Error(
      "ENGRAM_URL must be set in production — public URLs (magic links, OAuth callbacks) must not derive from request headers.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`ENGRAM_URL is not a valid URL: ${raw}`);
  }

  const isLocalhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new Error(
      `ENGRAM_URL must be https in production (got ${url.protocol}//${url.host}).`,
    );
  }

  for (const rawHost of (process.env.ENGRAM_ALLOWED_HOSTS || "").split(",")) {
    const host = rawHost.trim();
    if (!host) continue;
    let allowedUrl: URL;
    try {
      allowedUrl = new URL(`https://${host}`);
    } catch {
      throw new Error(`ENGRAM_ALLOWED_HOSTS contains an invalid host: ${host}`);
    }
    if (allowedUrl.protocol !== "https:" || allowedUrl.host !== host.toLowerCase() || allowedUrl.pathname !== "/") {
      throw new Error(`ENGRAM_ALLOWED_HOSTS entries must be bare HTTPS host authorities (got ${host}).`);
    }
  }

  const appUrlStatus = PLATFORM_APPS.map((app) => {
    const resolved = getOptionalAppUrl(app);
    return `${app.key}:${resolved ? new URL(resolved).origin : "missing"}`;
  }).join(" ");
  console.info(`[engram] resolved app URLs ${appUrlStatus}`);
}
