# Engram Security Audit — 2026-06-10

Status: complete (audit only — no fixes applied)
Scope: Engram identity/control-plane service; code @ `main` (`ce01c47`), plus
deployed configuration on on-prem (on-prem-host) and aws-dev.
Method: first pass driven by `docs/runbooks/security-audit.md` — re-verified
all 15 findings from `docs/security-audit-2026-05-20.md`, probed 10 areas the
prior audit did not cover, ran a production dependency audit, and checked
deployed env configuration in both environments.

## Summary

**14 of the 15 prior findings are still open.** The only one resolved since
2026-05-20 is the Next.js upgrade (#14, now 16.2.6; `npm audit --omit=dev` is
clean). None of the hard-gate items (HG-1..HG-4 in
`docs/plans/2026-05-31-security-hardgate-remediation.md`) have landed — the
gate for the first external pilot tenant remains fully unmet.

The new pass found **one deployed-config issue** (the native-auth fixture
endpoint is enabled on the public aws-dev host) and **six code findings**, the
most notable being a login timing oracle for account enumeration and the
complete absence of global security headers. Four areas were probed and came
back clean: native PKCE flow, redirect validation, CORS, and `users/me` mass
assignment — all solidly implemented.

Verdict unchanged from 2026-05-20: do not treat Engram as production-hardened
for external-customer PII until HG-1..HG-4 land. For internal use the posture
is acceptable but unmonitored (no audit logging).

## Deployed configuration

| Check | on-prem (on-prem-host) | aws-dev |
| --- | --- | --- |
| `ENGRAM_URL` set + canonical | ✅ `https://login.rapidagent.dev:8443` | ✅ `https://login.dev.ctxhost.com` |
| `NODE_ENV` | ✅ `production` | ✅ `production` |
| `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE` | ✅ unset | ❌ **`1` (enabled)** — see N-1 |
| `ENGRAM_COOKIE_DOMAIN` | `.rapidagent.dev` | `.dev.ctxhost.com` (parent-domain SSO — accepted trade-off per ADR-013; revisit before aws-prod) |
| `ENGRAM_ALLOWED_ORIGINS` | login/platform/lab/plexus hosts | `cortex` + `demo` tenant hosts |
| `ENGRAM_INTERNAL_API_KEY` | set | set |

Note: `ENGRAM_URL` being set in both envs means prior finding #4 (Host-header
URL derivation) is currently **mitigated by configuration**, but the code
fallback still exists and nothing guards against a future env regression —
keep HG-4 (startup guard) as planned.

## Prior findings status (from 2026-05-20 audit)

| # | Finding | Sev | Status | Current evidence |
| --- | --- | --- | --- | --- |
| 1 | change-password: no CSRF; OAuth-only users set password w/o verification | HIGH | **OPEN** | `src/app/api/auth/change-password/route.ts` — no `hasCrossOriginCookieWrite`; passwordHash-absent skip intact (lines 52–68) |
| 2 | No rate limiting on public auth endpoints | HIGH | **OPEN** | zero matches for `rateLimit\|429\|Retry-After` under `src/` |
| 3 | Entitlement IDOR — upsert for non-members of org | HIGH | **OPEN** | `…users/[userId]/app-entitlements/route.ts:78–84` checks user exists globally, not org membership |
| 4 | Host-header-derived public URLs | HIGH | **OPEN** (config-mitigated) | fallbacks intact in `magic-link/route.ts:58–60`, OAuth routes, `public-origin.ts:17–25`; no startup guard |
| 5 | `accessToken` in browser login JSON | HIGH | **OPEN** | `login/route.ts:90–99` (blocked on consumer audit rollout) |
| 6 | OAuth linking without verified provider email | HIGH/MED | **FIXED** (PR #97) | `findOrCreateOAuthUser` only links to an existing account when the provider verified the email; google.ts reads `verified_email`; github.ts uses the primary-verified `/user/emails` address, never the profile email |
| 7 | Refresh rotation not atomic | MED | **FIXED** (D1 / PR #99) | atomic consume+create in a `$transaction`; single-winner `deleteMany` (refresh + continue) |
| 8 | Logout clears cookies without `domain` | MED | **FIXED** (PR #91) | `clearAuthCookies` clears host-only + domain-scoped variants |
| 9 | Privileged routes trust JWT role claim | MED | **FIXED** (D2 / PR #100) | `isCurrentPlatformSuperadmin` re-reads DB role on all privileged routes |
| 10 | JWT verify: no alg pinning / audience | MED | **alg FIXED** (PR #91); aud deferred | HS256 pinned; audience awaits suite consumer rollout |
| 11 | Docker runs as root | MED | **FIXED** (D5 / PR #103) | runs as non-root `node`; verified `uid=1000` both envs |
| 12 | Roles are free-form strings | MED | **FIXED** (D3 / PR #101) | `PlatformRole`/`OrgRole` Postgres enums (in-place-cast migration) |
| 13 | Entitlement-users listing skips org-app gate | MED | **OPEN** | `…app-entitlements/[appKey]/users/route.ts:18–35` |
| 14 | Vulnerable Next.js 16.1.6 | MED | **FIXED** | `package.json` pins `next@16.2.6`; `npm audit --omit=dev`: 0 vulnerabilities |
| 15 | `hasCrossOriginCookieWrite` fail-open w/o Origin | LOW/MED | **OPEN** | `organizations.ts:92–98` returns false when Origin absent |

Security-adjacent commits since 2026-05-20: native-auth tenant admission gate
(`5483fc4`), public-origin tweak for native tenant hosts (`e791de9`), logout
redirect fix (`2aed9a5`), INTERNAL_API_KEY vault sourcing in deploy (`46c7806`).
None remediate findings 1–13/15.

## New findings

### N-1. MEDIUM — Native-auth fixture endpoint enabled on aws-dev

**Evidence:** `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE=1` in
`/opt/cortex/apps/engram/.env` on the aws-dev app host (confirmed in the
running container). On-prem correctly leaves it unset.

**Impact:** `/api/admin/native-auth-codes` mints native authorization codes on
the public `login.dev.ctxhost.com` host. The route is well-gated in code
(platform-superadmin auth + strict `=== "1"` check + cross-origin-write
block), so this is not an open door — but it is a code-minting backdoor
surface that should only exist while actively used for native-client testing,
and it compounds finding #9 (a stale superadmin JWT could mint codes).

**Fix:** unset it on aws-dev unless synapse-native testing currently needs
it; if it must stay, document the justification + removal condition. Add
"fixture flag unset" to the aws-prod launch checklist (it must never be set
there).

### N-2. MEDIUM — Login timing oracle enables account enumeration

**Evidence:** `src/app/api/auth/login/route.ts:51–56` returns 401 immediately
when the user doesn't exist (no bcrypt work); a wrong password for an existing
user costs a full bcrypt-12 compare (~250 ms). Bodies/statuses are identical;
timing is the leak. Secondary: `magic-link/route.ts:42` returns early for
unknown emails but awaits the Resend network call for existing ones — same
oracle, noisier.

**Impact:** remote attackers can enumerate which emails have accounts —
fuel for credential stuffing and targeted phishing on an identity provider.
Amplified by finding #2 (no rate limiting).

**Fix:** dummy bcrypt compare against a static hash on the unknown-user path;
for magic links, enqueue the email send instead of awaiting it (or send
fire-and-forget) so response time is uniform. Fold into HG-2 work.

### N-3. MEDIUM — No global security headers; token-bearing responses cacheable

**Evidence:** `next.config.ts` has no `headers()`; no `src/middleware.ts`
exists. No HSTS, CSP, `X-Frame-Options`/`frame-ancestors`, `nosniff`, or
`Referrer-Policy` anywhere globally (only `authorize` and `magic-link/verify`
set per-route headers). `login`, `refresh`, `token` (returns access+refresh
tokens in JSON), `logout`, and `GET /api/users/me` send no
`Cache-Control: no-store`.

**Impact:** the login page is frameable (clickjacking on an IdP), no HSTS on
first visit, and token-bearing JSON is cacheable by intermediaries.

**Fix:** add a `headers()` block (or middleware): HSTS w/ includeSubDomains,
`frame-ancestors 'none'` (or CSP), `nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`; add `Cache-Control: no-store` to all auth +
account responses. Engram-local, no consumer impact. Verify Caddy isn't
already adding these at the edge (it isn't expected to).

### N-4. MEDIUM — No security audit logging — ✅ SHIPPED 2026-06-10

**Evidence:** login success/failure not logged at all (`login/route.ts`);
admin user-create, admin password-reset, invite-create, role/entitlement
changes log only on exception. Only `refresh`/`continue` emit structured
events (userId only — confirmed no token/secret leakage anywhere in logs,
which is good).

**Impact:** no ability to detect credential stuffing, admin misuse, or an
account-takeover in progress; no forensic trail for an identity provider.

**Fix:** structured audit events (actor, action, target, org, IP, user-agent,
outcome) for login success/failure, password change/reset, magic-link
issue/consume, admin mutations, role + entitlement changes. A DB table or
stdout JSON both work; required before external tenants.

**Shipped:** durable `AuditLog` table (denormalized, no FKs so rows survive
user/org deletion; indexed on createdAt, orgId, actorUserId, action) +
`recordAuditEvent()` helper (`src/lib/audit.ts`, best-effort — never breaks
the request it describes). Wired into 18 events across login (success +
no-account/bad-password failure), logout, magic-link issue/consume, native
token exchange, refresh-reuse detection, password change + OAuth-only block,
admin user-create + password-reset, org member add/remove/role-change, and
org/user app + feature entitlement changes. No third-party PII is stored
(the no-account failure deliberately omits the attempted email; IP +
user-agent identify the attacker). Follow-up: an operator view/query surface
(currently queryable via SQL / the cortex-db helper) and a retention/purge
policy.

### N-5. LOW/MEDIUM — Magic links consumed on GET (scanner prefetch burns them) — ✅ FIXED (D4 / PR #102)

**Evidence:** `GET /api/auth/magic-link/verify` consumes the token and mints
a session directly (`verify/route.ts:15–92`). Consumption is atomic and
single-use (good), so a scanner can't replay — but corporate mail
link-scanners (Outlook SafeLinks etc.) will consume valid links before the
user clicks, and the scanner receives the Set-Cookie response.

**Fix:** interstitial page on GET with a POST "Continue" that performs
consumption. Also closes the login-CSRF window inherent in session-minting
GETs.

### N-6. LOW — `/api/internal/tls/allow` trusts the Host header for "loopback"

**Evidence:** `internal/tls/allow/route.ts:17` gates on
`isLoopbackRequestHost(request.headers.get("host"))` (`tenant-tls.ts:49–61`)
— purely client-controllable. Anyone who can reach port 3104 directly can
send `Host: localhost` and pass.

**Impact:** limited — the endpoint is only an org-slug existence oracle. But
the loopback assumption is unsound and will silently extend to anything else
added under `/api/internal/`.

**Fix:** bind the check to the socket/connection address (or move the
endpoint behind the internal API key), and keep 3104 firewalled to the host.

### N-7. INFO — Invite model has no token, expiry, or acceptance path

**Evidence:** `OrgInvite` (`schema.prisma:115–129`) has no token/tokenHash/
expiresAt; no acceptance endpoint exists; `acceptedAt` is never written.
Creation is platform-superadmin-only, so nothing is currently exploitable.

**Fix:** when invite acceptance is built, follow the magic-link pattern:
hashed single-use token, short expiry, atomic consumption, no role above the
inviter's grant.

## Clean areas (probed, no findings)

- **Native PKCE flow** — atomic single-use code consumption (`updateMany` +
  count check), code bound to client_id + redirect_uri, S256 only,
  timing-safe verifier compare, fixture route well-gated in code.
- **Redirect validation** (`auth-redirect.ts`) — blocks `//`, `/\`, userinfo,
  suffix/nested-subdomain tricks; tenant wildcard requires exact
  protocol+port and single-label non-reserved subdomain.
- **CORS** (`cors.ts`) — exact-match allowlist, credentialed GET only,
  `Vary: Origin` on all paths.
- **`users/me` PATCH** — explicit field allowlist (displayName, avatarUrl
  with https + length constraints); no mass assignment.
- **No secrets/tokens in logs** across `src/` and `scripts/`.
- **Dependencies** — `npm audit --omit=dev` clean; next 16.2.6.

## Prioritized remediation queue

Hard gate before the first external pilot tenant (unchanged, still unmet —
see the remediation plan):

1. **HG-1** — entitlement IDOR + listing gate (#3, #13). Tenant-isolation
   break; the single most important fix.
2. **HG-2** — rate limiting on login/refresh/magic-link/token (#2), now
   bundled with the **N-2 timing-oracle fix** (same files, same tests).
3. **HG-3** — CSRF on change-password + OAuth-only re-auth (#1, #15).
4. **HG-4** — `ENGRAM_URL` startup guard (#4).

Next tier (Engram-local, no consumer impact — schedule after or alongside the
gate):

5. **N-3** security headers + no-store (cheap, high blast-radius reduction).
6. **N-1** unset the aws-dev fixture flag (config-only, minutes).
7. **N-4** audit logging (required before external tenants in practice, even
   though not in the original gate).
8. #6 OAuth verified-email linking, #7 atomic refresh rotation, #8 logout
   cookie domain, #9 DB role re-read for privileged routes, #10 alg pinning
   (the HS256 pin is safe now; `aud` waits for consumer rollout).
9. #11 Docker non-root, #12 role enums, N-5 magic-link interstitial, N-6
   loopback check.

Deferred pending suite consumer rollout (unchanged from 2026-05-20): #5
(accessToken in login JSON), strict `aud` validation, HS256→JWKS migration,
cookie-scope changes.
