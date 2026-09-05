# Engram Security Audit — Hard-Gate Verification (2026-06-10)

Status: complete (verification pass — confirms the external-tenant gate is closed)
Scope: re-run of `docs/runbooks/security-audit.md` against `main` after the
2026-06-10 remediation sprint (PRs #90–#95), plus deployed-config checks on
on-prem and aws-dev.
Method: adversarial re-verification of all four hard-gate fixes and every
finding from `docs/security-audit-2026-06-10.md`, by independent read-only
agents over current code; live deployed-config check via SSM.

## Verdict

**The external-tenant hard gate (HG-1..HG-4) is CLOSED.** The verification
found one residual of the HG-3 invariant — `PATCH /api/users/me` was the only
cookie-authenticated mutation not calling `hasCrossOriginCookieWrite` — which
was fixed in this pass (the guard added + tests). With that, all four gate
items hold adversarially.

All other audit findings are in their expected state: N-1..N-4 fixed, the
HS256 pin in place. **#6 (OAuth verified-email linking) — the account-takeover
vector this pass flagged as the highest-value open item — was fixed
immediately after (PR #97).** The remaining deferred/lower-priority items
(#5, #7, #9, #11, #12, N-5, N-6, JWT `aud`) stay open by design and are
tracked below.

## Deployed configuration (live)

| Check | on-prem | aws-dev |
| --- | --- | --- |
| `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE` | unset | unset (0) ✅ |
| `ENGRAM_URL` | https, canonical | `https://login.dev.ctxhost.com` ✅ |
| `NODE_ENV` | production | production ✅ |
| `AuditLog` table (N-4 migration) | `0011_audit_log` applied | applied ✅ |
| Audit write path | — | verified live (login.failure rows written with IP/UA, no email) ✅ |
| Security headers (N-3) | present | present ✅ |

## Hard-gate verification

| Gate | Verdict | Evidence |
| --- | --- | --- |
| **HG-1** entitlement IDOR | **CLOSED** | `ensureTargetIsOrgMember` (404) on GET+PUT for all callers; listing route gated + member-filtered; member-removal purges overrides transactionally. Adversarial sweep of all 5 `userAppEntitlement` writers/readers + app-switcher: no cross-tenant path. |
| **HG-2** rate limiting | **CLOSED** | `src/lib/rate-limit.ts` wired into login (IP + email+IP lockout), refresh, token, magic-link, and the `continue` rotation path; 429 + Retry-After. Lockout key is email+IP (not victim-lockable). No fail-open except the explicit `ENGRAM_RATE_LIMIT_DISABLED=1` test bypass (not set in any deployed env). `register` is a 403 stub; magic-link tokens are 286-bit single-use. |
| **HG-3** change-password CSRF | **CLOSED** (was PARTIAL) | `hasCrossOriginCookieWrite` fails closed (no trusted Origin + no same-origin `Sec-Fetch-Site` → block); wired into change-password. **Verification found `PATCH /api/users/me` missing the guard — fixed in this pass** (`src/app/api/users/me/route.ts`, + `tests/api/users-me.test.ts`). All cookie-auth mutations now carry the guard. |
| **HG-4** `ENGRAM_URL` guard | **CLOSED** | `src/instrumentation.ts` throws at prod boot unless `ENGRAM_URL` is set + https; Next 16 runs `register()` on this deploy; host-header fallbacks in `public-origin.ts`/oauth/magic-link are unreachable in prod. |

## Finding status (non-gate)

| ID | Status | Note |
| --- | --- | --- |
| N-1 fixture flag | FIXED | strict `=== "1"` + superadmin + cross-origin block; unset in deployed envs |
| N-2 login timing oracle | FIXED | dummy bcrypt on unknown-account; constant-time response floor on the email paths (`settleAfter`, 2026-07-14 — replaced the original fire-and-forget email, which was silently dropping all mail on Lambda); audit-log change is timing-symmetric across both failure paths |
| N-3 security headers | FIXED | HSTS, X-Frame-Options + frame-ancestors, nosniff, Referrer-Policy, `/api` no-store |
| N-4 audit logging | FIXED | `AuditLog` + `recordAuditEvent` (best-effort), 22 call sites / 15 routes; verified writing live |
| N-5 magic-link GET consume | FIXED (D4 / PR #102) | GET renders an interstitial; consumption moved to a same-origin POST |
| N-6 tls/allow loopback | OPEN | Host-header-spoofable; org-slug existence oracle only (low) |
| #5 accessToken in login JSON | OPEN | deferred — needs suite consumer audit |
| #6 OAuth verified-email linking | FIXED (PR #97) | links to an existing account only on a provider-verified email; GitHub uses the primary-verified `/user/emails` address, Google reads `verified_email` |
| #7 refresh rotation atomicity | FIXED (D1 / PR #99) | atomic consume+create in a `$transaction`; single-winner `deleteMany` |
| #9 privileged routes trust JWT role | FIXED (D2 / PR #100) | `isCurrentPlatformSuperadmin` re-reads the DB role on all privileged routes |
| #10 JWT alg/aud | alg FIXED, aud OPEN | HS256 pinned; audience deferred |
| #11 Docker non-root | FIXED (D5 / PR #103) | runs as the built-in `node` user; verified `uid=1000` on both envs |
| #12 role enums | FIXED (D3 / PR #101) | `PlatformRole`/`OrgRole` Postgres enums; in-place-cast migration, data preserved |

## Remaining open items

The verified-email set-password flow (D7 / ADR-017, PR #104) is shipped, so
the HG-3 OAuth-only 409 now has a real destination. The `brace-expansion`
advisory is resolved (D6 / PR #103: bumped aws-cdk-lib, where it was a bundled
dep). What's left, all low-severity defense-in-depth:

1. **N-6** tls/allow Host-header loopback (low — org-slug existence oracle).
2. The entitlement DB composite FK (`UserAppEntitlement → OrgMember`), now
   safe to add (data clean); audit-log operator view + retention policy.
3. ~~The refresh-token-family grace window (consumedAt/replacedByTokenId) so a
   benign concurrent refresh doesn't revoke the whole family (the D1 follow-up).~~
   **DONE 2026-07-22 (ADR-031).** Shipped as a `consumedAt` + encrypted-`replacement`
   grace window: a token rotated within 30 s is graced — every concurrent/retry
   caller gets the **same** successor (idempotent; the successor is stored
   AES-GCM-encrypted, key derived from `ENGRAM_JWT_SECRET`), so there is one chain
   and no parallel session — instead of revoking the family; reuse *outside* the
   window still revokes. Root cause of users being logged out on every client
   deploy (cross-instance concurrent refresh of the single-use token).

Deferred behind the suite consumer rollout (unchanged): #5, JWT `aud`,
HS256→JWKS.

## History note

This verification ran the same day as the initial 2026-06-10 audit because
the full remediation sprint landed that day. The next scheduled audit should
be a fresh full pass (not just verification) before the first external pilot
tenant onboards.
