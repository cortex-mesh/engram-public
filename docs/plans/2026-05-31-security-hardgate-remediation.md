# Security Hard-Gate Remediation — Engram

**Date:** 2026-05-31
**Status:** ✅ Gate VERIFIED CLOSED — HG-1..HG-4 shipped + deployed + adversarially re-verified 2026-06-10 (`docs/security-audit-2026-06-10-gate-verification.md`). Verification caught + fixed one residual (`users/me` PATCH CSRF). A fresh full audit is still recommended before the first external pilot tenant lands.
**Scope:** The minimum Engram security fixes required **before any external paying customer's data sits on the shared hosted suite.** Derived from `docs/security-audit-2026-05-20.md` (reviewer: Hermes). The full audit has 15 findings; this plan gates on the subset that breaks **tenant isolation** or exposes **public-auth abuse** for a multi-tenant external customer. The remaining findings are tracked separately (some require the suite consumer audit first).
**Related:** `docs/security-audit-2026-05-20.md`, `docs/suite-auth-consumer-audit-2026-05-20.md`, ADR-013 (`browser-sso-cookie-and-csrf-contract`).

## Why now

The monetization plan puts **external SMB tenants (home care) on the shared hosted suite.** Today an org owner/admin can write app-entitlement override rows for users who are **not members of their org** (audit #3) — a direct tenant-isolation break. That, plus unthrottled public auth endpoints and a CSRF gap on password change, is the gate to clear before real external customer data lands. **This does not block the fake-data POC demo; it blocks the first real pilot tenant.**

## In scope — the gate

### HG-1 — Cross-org / IDOR on user app entitlements ⭐ (audit #3 + #13, HIGH) — ✅ SHIPPED 2026-06-10
The tenant-isolation breaker; highest priority.
- **Evidence:** `src/lib/user-app-entitlements.ts:80-88` checks only caller is owner/admin of `orgId`; `src/app/api/orgs/[orgId]/users/[userId]/app-entitlements/route.ts:78-120` validates the target user *globally* and upserts for arbitrary `userId+orgId`; `prisma/schema.prisma:86-100` models `UserAppEntitlement` with no FK to `OrgMember`. Listing route `src/app/api/orgs/[orgId]/app-entitlements/[appKey]/users/route.ts:18-35` skips `ensureOrgHasAppEntitled()` and returns identity fields.
- **Fix:** require target **org membership** before GET/PUT/DELETE of per-user entitlements; return **404** for non-members (no enumeration); gate the listing via `ensureOrgHasAppEntitled()` and filter through `OrgMember`; add a **cleanup report** for existing invalid rows; consider a DB relation/migration tying `UserAppEntitlement(userId, orgId)` → `OrgMember(userId, orgId)`.
- **Size:** M.

### HG-2 — No rate limiting on public auth endpoints (audit #2, HIGH)
- **Evidence:** `src/app/api/auth/login/route.ts:15-65`, `refresh/route.ts:13-132`, `magic-link/route.ts:44-53` — no throttle/lockout; no `rateLimit`/`429`/`Retry-After` anywhere under `src`.
- **Fix:** centralized rate limiting keyed by trusted client IP + normalized email/user ID + endpoint; progressive delay/lockout on login failure; rate-limit magic links by IP/email-hash/subnet; return `429` + `Retry-After`. Add a test-mode bypass so suite tests/scripts aren't throttled.
- **Size:** S–M.

### HG-3 — CSRF on cookie-authenticated change-password (audit #1 + #15, HIGH) — ✅ SHIPPED 2026-06-10
- **Evidence:** `src/app/api/auth/change-password/route.ts:7,52-79` authenticates via cookie and skips current-password verification for OAuth-only users; does not call `hasCrossOriginCookieWrite()`/require a CSRF token. Origin-only helper `src/lib/organizations.ts:92-98` is brittle when `Origin` is absent.
- **Fix:** add real CSRF protection (token / double-submit) to cookie-authenticated unsafe methods, starting with change-password, **with bearer-client compatibility**; require re-auth / verified magic link / OAuth challenge before OAuth-only users set an initial password; deny missing `Origin`/`Sec-Fetch-Site` for cookie-auth unsafe methods.
- **Size:** S.

### HG-4 — Host-header-derived public URLs (audit #4, HIGH) — cheap adjacent fix
- **Evidence:** `src/app/api/auth/magic-link/route.ts:58-65` and `oauth/google/callback/route.ts:34-36` fall back to `x-forwarded-proto + host`; `src/lib/jwt.ts:4-10` guards `ENGRAM_JWT_SECRET` in prod but nothing guards `ENGRAM_URL`.
- **Fix:** fail startup in production unless `ENGRAM_URL` is set to an HTTPS allowlisted origin; stop deriving security-sensitive URLs from Host/X-Forwarded headers in prod; validate scheme/host at startup.
- **Size:** S.

## Explicitly out of scope (defer — needs suite consumer audit first)
Per the audit's remediation order, these change shared browser-SSO contracts and must wait for the consumer audit: removing `accessToken` from browser login/refresh JSON (#5), strict JWT `aud` / HS256→JWKS migration (#10), cookie scope/name/domain changes. Other MEDIUM hardening (#6–#9, #11, #12, #14) is worthwhile but not part of *this* external-customer gate.

## Tasks
- [x] **HG-1a** — Target-org-membership check (`ensureTargetIsOrgMember`) on per-user entitlement GET + PUT; 404 (not 403) for non-members, enforced for superadmin too. DELETE intentionally left able to remove rows (org-scoped; blocking would strand orphan rows from cleanup).
- [x] **HG-1b** — Entitlement-users listing gated via `ensureOrgHasAppEntitled()` + filtered through `OrgMember` (`user.orgMembers.some.orgId`) so orphan-row identity fields are never returned.
- [x] **HG-1c** — Cleanup report `scripts/report-orphan-entitlements.mjs` (read-only; `--delete` to remove). Ran against aws-dev + on-prem 2026-06-10: **0 orphan rows** (aws-dev 1 valid override, on-prem 0) — the IDOR was never exploited, no cleanup needed. DB-level composite FK `UserAppEntitlement(userId,orgId) → OrgMember(userId,orgId)` deferred as follow-up (now safe to add since data is clean; brings cascade-delete-on-member-removal).
- [x] **HG-2** — Centralized rate limiter on `login`/`refresh`/`magic-link`(+`token`); `429`+`Retry-After`; test-mode bypass (`ENGRAM_RATE_LIMIT_DISABLED=1`). Includes the N-2 timing-oracle fix (dummy bcrypt for unknown accounts, fire-and-forget magic-link send).
- [x] **HG-3** — CSRF on change-password: `hasCrossOriginCookieWrite` hardened to fail closed when a cookie-bearing write has no trusted Origin / `Sec-Fetch-Site` (fixes #1 + #15 across all routes that use it), wired into change-password; bearer/internal callers exempt (no cookie). OAuth-only initial-password set now blocked (409) instead of skipping verification — a verified-email set-password flow is the deferred path.
- [x] **HG-4** — Production `ENGRAM_URL` startup guard (`src/instrumentation.ts`, PR #91). Host-header fallbacks still exist in code but are unreachable in prod with the guard; consolidating call sites onto `getPublicOrigin` is follow-up cleanup.
- [ ] **Verify** — `npm run typecheck` + `npm run lint`; tests proving cross-org denial (404), rate-limit `429`, CSRF rejection; deploy to aws-dev + on-prem.

## Verification & review
- Targeted tests for each fix (cross-org denial, throttle, CSRF reject) + `npm run typecheck`/`npm run lint`.
- **Security review before merge:** run `/code-review ultra` on the branch (security/auth surface; user-triggered).
- Deploy to aws-dev and on-prem; re-check the audit evidence lines are addressed.

## Execution / owner
Engram task — suitable for Ryan or a fleet eng-domain agent. Security-sensitive, so route through `/code-review ultra` before the PR merges. **Gate:** HG-1 (+ ideally HG-2/HG-3) must land before the first real external pilot tenant; not required for the fake-data POC demo.

## Progress Log
| Date | Update |
| --- | --- |
| 2026-05-31 | Plan created from the 2026-05-20 audit. Scoped to the external-customer hard gate (HG-1..HG-4). No code changes yet. |
| 2026-06-10 | Re-audit (`docs/security-audit-2026-06-10.md`, via new `docs/runbooks/security-audit.md`): HG-1..HG-4 all still open. Fold the new login timing-oracle fix (N-2) into HG-2. New non-gate items: security headers (N-3), aws-dev fixture flag unset (N-1), audit logging (N-4). |
| 2026-06-10 | Quick wins shipped (PR #91): N-3 headers + no-store, HG-4 startup guard, HS256 pin, logout dual-variant cookie clear. N-1 fixture flag removed from the aws-dev secrets bundle. Verified live both envs. |
| 2026-06-10 | HG-2 + N-2 shipped: in-memory fixed-window limiter (`src/lib/rate-limit.ts`) on login (10/min/IP + 5-failure/15-min lockout keyed email+IP, cleared on success), refresh + continue rotation (shared 60/min/IP bucket), token (10/min/IP, OAuth-shaped `slow_down` 429), magic-link (10/15min/IP + 3/15min/email, replacing the old DB 5-min recent-link check); dummy bcrypt compare for unknown accounts; magic-link send fire-and-forget with Resend `{error}` logging. Bypass: `ENGRAM_RATE_LIMIT_DISABLED=1`. Remaining gate: HG-1, HG-3. |
| 2026-06-10 | HG-1 shipped (the tenant-isolation breaker): `ensureTargetIsOrgMember` 404-gates per-user entitlement GET/PUT for all callers (superadmin included; membership check ordered before the org-app gate for uniform 404); listing route gated + member-filtered; member-removal now purges the user's per-org overrides in a transaction (closes the real orphan path); orphan-row report script added and run on both envs (0 orphans). Code review (4 agents) found no correctness bugs. Remaining gate: **HG-3** (change-password CSRF). |
| 2026-06-10 | **HG-3 shipped → GATE COMPLETE.** `hasCrossOriginCookieWrite` now fails closed for cookie writes lacking a trusted Origin / same-origin `Sec-Fetch-Site` (fixes #1 + #15 across all ~10 routes that use it); change-password wired through it; OAuth-only initial-password set blocked (409). All four gate items (HG-1..HG-4) are merged. Follow-ups: verified-email set-password flow (so OAuth-only users have a path), N-4 audit logging, DB composite FK for entitlements. |
| 2026-06-10 | N-4 audit logging shipped (#95) + gate verification (#96, `docs/security-audit-2026-06-10-gate-verification.md`) — gate VERIFIED CLOSED; verification caught + fixed a `users/me` PATCH CSRF residual. **#6 OAuth verified-email linking shipped (#97)** — closes the last account-takeover vector (links to an existing account only on a provider-verified email). No takeover/tenant-isolation finding remains open; everything left is defense-in-depth. |
