# Incident - Gyrus app-switcher omitted by missing public URL (2026-07-23)

**Severity:** medium (one restricted Cortex member could authenticate but could
not use Gyrus) · **Surface:** aws-dev hosted suite
(`login.dev.ctxhost.com`, `cortex.dev.ctxhost.com/gyrus`) · **Author:** Roland
+ Codex session

## Summary

A Cortex org member could sign in through Engram with email/password and Google,
but attempts to open `https://cortex.dev.ctxhost.com/gyrus` returned the browser
to `https://cortex.dev.ctxhost.com/`.

This looked like a Gyrus authorization failure, but Playwright showed that the
browser successfully loaded `/gyrus` with HTTP `200`. After hydration, the
shared `@cortex-mesh/app-header` fetched Engram's `/api/me/app-switcher`,
received an app list containing only `nexus`, and redirected the user back to
the tenant root because `currentApp="gyrus"` was not entitled in the switcher
payload.

## Root Cause

The user and org data were correct:

- user was email-verified
- user was a Cortex org `MEMBER`
- Cortex had `OrgAppEntitlement(gyrus)` enabled
- Gyrus was `RESTRICTED`
- user had `UserAppEntitlement(gyrus).enabled=true`

The missing piece was runtime configuration. `NEXT_PUBLIC_GYRUS_URL` was absent
from the `engram-dev-runtime` Secrets Manager bundle. In production mode,
Engram's app catalog intentionally omits apps whose public URL is unset, so
`resolveEntitledApps()` filtered out Gyrus even though the database allowed it.

## Contributing Factors

- The failure appeared after successful authentication, so it initially looked
  like a Gyrus cookie or app-admission problem.
- Direct API checks of `/api/auth/login` were green because login redirect
  preservation is separate from app-switcher app visibility.
- A valid `OrgAppEntitlement` and `UserAppEntitlement` were not sufficient;
  the production runtime URL gate also had to be satisfied.
- Earlier stale host/domain cookie duplication issues created a plausible but
  separate failure mode during the same investigation.

## Fix

1. Added `NEXT_PUBLIC_GYRUS_URL=https://cortex.dev.ctxhost.com/gyrus` to
   `engram-dev-runtime`.
2. Redeployed Engram aws-dev using the existing deploy workflow.
3. Verified `/api/me/app-switcher` returned both:
   - `nexus` -> `https://cortex.dev.ctxhost.com/`
   - `gyrus` -> `https://cortex.dev.ctxhost.com/gyrus`
4. Verified with Playwright:
   - direct login to `/gyrus` stayed on `/gyrus`
   - Nexus showed a Gyrus launcher link
   - clicking the launcher stayed on `/gyrus`
   - Gyrus page content rendered

## Prevention

- Treat `NEXT_PUBLIC_*_URL` variables as part of the app entitlement contract,
  not just UI configuration.
- When adding a hosted app to Engram, verify all three layers:
  catalog key, database entitlement, and configured runtime URL.
- Add an app-switcher smoke check for every hosted app in aws-dev deploy
  verification.
- For browser reports, capture top-level navigation and `/api/me/app-switcher`
  responses before changing consumer app code.

## References

- Runbook: `docs/runbooks/hosted-app-login-and-switcher.md`
- Related Gyrus runbook:
  `gyrus/docs/runbooks/hosted-login-troubleshooting.md`
