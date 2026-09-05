# ADR-023: Fix engram-specific standalone `cookies()` regression — middleware fallback + Next.js upgrade

- **Date:** 2026-06-15
- **Status:** Accepted

## Context

After PR #70 (Next.js 16.1.6 → 16.2.6 + Dockerfile/root-layout changes, 2026-05-22), Engram's authenticated page routes (`/`, `/account`, `/admin`) fell into a post-login redirect loop. In the standalone build, `cookies()` from `next/headers` returned empty in **server components**: the AsyncLocalStorage work-unit store was not populated with request cookie data, even though the raw `Cookie` header reached the origin. Confirmed: `GET /api/users/me` (a route handler using `request.cookies`) returned 200, while `GET /account` (a server component using `await cookies()`) returned 307 → `/login` with the same cookie.

**This is not a blanket Next 16.2.x standalone bug.** Nexus and Pulse run the same Next.js version and the same standalone deployment stack without this issue — so the regression is **engram-specific**. As of this ADR's date the exact cause is **unconfirmed**; the most likely hypothesis is that Engram's custom instrumentation (`src/instrumentation.ts`) or the Prisma PG adapter initialization interferes with the Next.js AsyncLocalStorage work-unit store, so the request store is not populated when a server component reads `cookies()`.

Confirmed scope: route handlers (`/api/**`) using `request.cookies` were **never** affected; only **server components** calling `cookies()` from `next/headers` were broken. `admin/layout.tsx` already had `force-dynamic` yet was still broken, proving `force-dynamic` alone is insufficient.

## Decision

Apply four fixes in combination:

1. **Upgrade Next.js 16.2.6 → 16.2.9.** May patch a relevant work-unit-store issue; the workarounds below ensure correctness regardless.
2. **Middleware cookie forwarding.** `src/middleware.ts` intercepts `/`, `/account`, `/admin/*`, reads the `engram-access` cookie via `request.cookies` (which works in middleware), and forwards it as an `x-engram-access` request header. A helper `getAccessTokenFromRequest()` (`src/lib/server-cookies.ts`) tries `cookies()` first, then falls back to `headers().get('x-engram-access')`. All affected page components use this helper.
3. **Redirect outside try/catch.** Redirect logic moved to `resolvePostLoginTarget()` (`src/lib/session-redirect.ts`), which **returns a target URL** rather than calling `redirect()`; the page calls `redirect()` outside any try/catch so the internal `NEXT_REDIRECT` throw is not swallowed.
4. **`force-dynamic`** on the affected pages (`page.tsx`, `account/page.tsx`) to guarantee request-time rendering.

## Consequences

| Pros | Cons |
| ---- | ---- |
| Login loop fixed for multi-org users and superadmins | Belt-and-suspenders: middleware + helper is more moving parts than a clean `cookies()` |
| Correct regardless of whether 16.2.9 patches the issue | `x-engram-access` header path must be kept in sync with the cookie name |
| Centralized `getAccessTokenFromRequest()` for all server pages | Slight middleware overhead on the matched routes |
| `redirect()` no longer swallowed by error handling | Workaround should be revisited/removed once the upstream cause is confirmed |

- The workaround should be **revisited and removed once the upstream cause is confirmed** — because the regression is engram-specific (Nexus/Pulse are unaffected), the durable fix is likely in Engram's own instrumentation/adapter init, not a Next.js upgrade.
- The `x-engram-access` header forwarding path **must be kept in sync with the cookie name** (`engram-access`); a rename in one place without the other silently breaks the fallback.

## Related

- **ADR-024** — Post-login routing to the most-recently-used org's Nexus further improves post-login routing by removing the `/account` intermediate, which also reduces exposure to this server-component `cookies()` fragility (the `/account` page being the most affected surface).
