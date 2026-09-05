# Engram Security Audit Checkpoint — 2026-05-20

Status: checkpoint, pending suite consumer audit
Scope: Engram identity/control-plane service at `/Users/roland/Projects/cortex-mesh/engram`
Reviewer: Hermes

## Summary

Engram is the identity root for the hosted suite and stores user, organization, membership, and entitlement information. This checkpoint records the initial Engram-only findings before changing any auth contract used by Nexus, Synapse, Thoughts, Pulse, Plexus, or other consumers.

Verdict: request changes before treating Engram as production-hardened for user/org PII.

Several fixes are Engram-internal and can be implemented with low suite impact. A smaller set touches shared browser SSO contracts: JWT audience/algorithm policy, cookie scope, login/refresh JSON response shape, and entitlement semantics. Those contract changes should wait for the suite consumer audit.

## Consumer-impact categories

### Low suite impact / Engram-local fixes

- Add application/edge rate limiting for login, magic link, token exchange, and refresh endpoints.
- Require and validate `ENGRAM_URL` in production; stop deriving security-sensitive public URLs from Host/X-Forwarded headers in production.
- Fix logout cookie clearing to use the same domain/path attributes used when cookies are set.
- Make refresh-token rotation atomic without changing response shape.
- Require verified OAuth email before account linking.
- Re-read current DB role for privileged Engram admin APIs.
- Run the Docker runtime as a non-root user.
- Add app-level security headers and no-store behavior for sensitive responses.
- Add DB constraints/enums for authorization-critical role fields.

### Requires suite consumer audit before changing

- Removing `accessToken` from browser login/refresh JSON responses.
- Adding strict JWT `aud` validation or app-specific audiences.
- Migrating from shared HS256 secret validation to asymmetric JWKS.
- Changing cookie names, domain, path, SameSite, or SSO propagation semantics.
- Tightening user-app entitlement semantics where consumers may currently tolerate stale/invalid rows.
- Requiring CSRF tokens/headers on Engram mutation APIs if any suite frontend calls those endpoints directly with cookies.

## Findings

### 1. HIGH — Cookie-authenticated password change lacks CSRF protection; OAuth-only users can set a password without current-password verification

Evidence:

- `src/app/api/auth/change-password/route.ts:7` authenticates via `authenticateRequest()`.
- `src/lib/auth.ts:30-37` accepts the `engram-access` cookie as authentication.
- `src/app/api/auth/change-password/route.ts:52-68` skips current-password verification when `user.passwordHash` is absent.
- `src/app/api/auth/change-password/route.ts:70-79` sets the password and deletes refresh tokens.
- This route does not call `hasCrossOriginCookieWrite()` or require a CSRF token, unlike admin/org mutation routes such as `src/app/api/admin/users/route.ts:111-116`.

Impact:

A same-site subdomain CSRF risk exists because Engram uses cookie-based SSO. For OAuth-only users, a cookie-authenticated unsafe request could set an attacker-chosen local password.

Recommended fix:

- Add CSRF protection to all cookie-authenticated unsafe methods, starting with change-password.
- Prefer a real CSRF token/double-submit token over Origin-only checks.
- Require re-authentication, verified magic link, or OAuth challenge before OAuth-only users set an initial password.

Consumer impact:

Potentially affects suite frontends only if they POST directly to Engram mutation endpoints with cookies. Audit consumers before requiring a new CSRF header/token globally.

### 2. HIGH — No effective rate limiting on public auth endpoints

Evidence:

- `src/app/api/auth/login/route.ts:15-65` performs email lookup and bcrypt verification without throttling or lockout.
- `src/app/api/auth/refresh/route.ts:13-132` rotates refresh tokens without endpoint throttling.
- `src/app/api/auth/magic-link/route.ts:44-53` only suppresses recent links for existing users; there is no IP/global throttle.
- No implementation was found for `rateLimit`, `throttle`, `429`, or `Retry-After` under `src`.

Impact:

Credential stuffing, password spraying, refresh endpoint abuse, and magic-link/email abuse are practical risks for a public identity service.

Recommended fix:

- Add centralized rate limiting keyed by trusted client IP, normalized email/user ID, and endpoint.
- Add progressive delay/lockout for login failures.
- Rate-limit magic links by IP, email hash, and subnet.
- Return `429` with `Retry-After`.

Consumer impact:

Low, but tests/scripts that repeatedly log in may need test-mode limits or adjusted pacing.

### 3. HIGH — User app entitlement routes allow cross-org/IDOR-style overrides for arbitrary users

Evidence:

- `src/lib/user-app-entitlements.ts:80-88` checks only that the caller is owner/admin of `orgId`.
- `src/app/api/orgs/[orgId]/users/[userId]/app-entitlements/route.ts:78-84` validates the target user globally with `prisma.user.findUnique({ id: userId })`.
- `src/app/api/orgs/[orgId]/users/[userId]/app-entitlements/route.ts:98-120` upserts an entitlement for arbitrary `userId + orgId`.
- `prisma/schema.prisma:86-100` models `UserAppEntitlement` as independent references to `User` and `Organization`, with no FK to `OrgMember(userId, orgId)`.

Impact:

An org owner/admin can create app entitlement override rows for a user who is not a member of that org. That violates tenant isolation and can pollute authorization state if consumers trust those rows.

Recommended fix:

- Require target org membership before GET/PUT/DELETE of per-user app entitlements.
- Return 404 for non-members to avoid user enumeration.
- Add a DB-level relation or migration guard tying `UserAppEntitlement(userId, orgId)` to `OrgMember(userId, orgId)` if practical.
- Add a cleanup report for existing invalid override rows before enforcing constraints.

Consumer impact:

Potentially medium. Consumers should not rely on invalid override rows, but stale data may exist and should be audited before enforcement.

### 4. HIGH — Host-header-derived public URLs can poison magic-link/OAuth flows if `ENGRAM_URL` is unset or wrong

Evidence:

- `src/app/api/auth/magic-link/route.ts:58-65` builds the verification URL from `ENGRAM_URL` or `x-forwarded-proto + host`.
- `src/app/api/auth/oauth/google/callback/route.ts:34-36` uses the same base URL fallback.
- `.env.example:4` documents `ENGRAM_URL=http://localhost:3104`.
- `src/lib/jwt.ts:4-10` requires `ENGRAM_JWT_SECRET` in production, but there is no similar production guard for `ENGRAM_URL`.

Impact:

If production lacks `ENGRAM_URL`, or a proxy forwards attacker-controlled Host/X-Forwarded-Proto, magic-link emails or OAuth redirect URIs can point to attacker-controlled origins. Magic-link tokens could leak.

Recommended fix:

- Fail startup in production unless `ENGRAM_URL` is set to an HTTPS allowlisted origin.
- Do not derive security-sensitive public URLs from Host/X-Forwarded headers in production.
- Validate `ENGRAM_URL` scheme/host at startup.

Consumer impact:

Low if deployed environments already set canonical URLs correctly.

### 5. HIGH — Browser login response returns `accessToken` despite setting httpOnly cookies

Evidence:

- `src/app/api/auth/login/route.ts:89-98` includes `accessToken` in the JSON response.
- `src/app/api/auth/login/route.ts:100-101` also sets httpOnly access/refresh cookies.

Impact:

Returning access tokens to browser JavaScript weakens the protection of httpOnly cookies. XSS, browser extensions, or frontend logging can capture the bearer token.

Recommended fix:

- Browser login should return only user metadata and `postLoginTarget`.
- Keep token JSON responses isolated to native/API flows such as `/api/auth/token`.

Consumer impact:

Unknown. Must audit Nexus, Synapse, Thoughts, Pulse, and Plexus for code that reads `accessToken` from Engram login/refresh responses before removing it.

### 6. HIGH/MEDIUM — OAuth account linking trusts provider email without consistently proving it is verified

Evidence:

- `src/lib/db/oauth-accounts.ts:31-43` links a provider account to an existing user by email and marks `emailVerified=true`.
- `src/lib/oauth/google.ts:35-40` fetches Google userinfo but does not check `verified_email`/`email_verified`.
- `src/lib/oauth/github.ts:31-50` only calls `/user/emails` when `user.email` is null; otherwise it trusts `user.email` directly.

Impact:

Email-based account linking is safe only when the provider asserts the email is verified. Otherwise, an unverified provider email can potentially link to an existing local account.

Recommended fix:

- Google: validate ID token or userinfo `verified_email/email_verified === true`.
- GitHub: always fetch `/user/emails` and choose a primary verified email for linking.
- Require a separate email-verification flow when verified email is unavailable.

Consumer impact:

Low. May affect new OAuth linking edge cases only.

### 7. MEDIUM — Refresh-token rotation is not atomic

Evidence:

- `src/app/api/auth/refresh/route.ts:61-80` does `findFirst()` then `delete()` outside a transaction.
- `src/app/api/auth/refresh/route.ts:96-110` creates the replacement refresh token separately.

Impact:

Concurrent refreshes can race and cause avoidable logout, denial of service, or confusing theft/reuse signals.

Recommended fix:

- Consume old token and create replacement in one transaction.
- Use conditional `deleteMany`/`updateMany` and require `count === 1` before issuing a new token.
- Longer-term, model refresh-token families with `consumedAt`, `revokedAt`, and `replacedByTokenId`.

Consumer impact:

Low if response shape stays unchanged.

### 8. MEDIUM — Logout may not clear domain-scoped SSO cookies

Evidence:

- `src/lib/jwt.ts:74-89` sets cookie domain when `ENGRAM_COOKIE_DOMAIN` is configured.
- `src/app/api/auth/logout/route.ts:6-11` clears cookies with path/maxAge but omits domain.

Impact:

If cookies were set for a parent domain, logout may clear only a host-only cookie while the domain cookie survives.

Recommended fix:

- Clear cookies with the same domain/path/SameSite/secure attributes used when setting them.
- Add shared helpers for setting and clearing Engram cookies.

Consumer impact:

Low and likely positive. Do not change cookie scope as part of this fix.

### 9. MEDIUM — Platform SUPERADMIN authorization trusts the role claim in the access JWT

Evidence:

- `src/lib/auth.ts:34-36` and `src/lib/auth.ts:50-52` return role directly from JWT payload.
- `src/lib/jwt.ts:15` gives access tokens a 15-minute TTL.
- Sensitive routes authorize using `auth.role`, e.g. `src/app/api/orgs/route.ts:93-97`, `src/app/api/admin/users/route.ts:118-120`, and `src/app/api/admin/users/[userId]/password/route.ts:45-47`.

Impact:

If a superadmin is demoted in the DB, existing access tokens can still authorize high-risk APIs until expiry.

Recommended fix:

- For privileged Engram APIs, reload the current user role from DB after token verification.
- Add a helper such as `requireCurrentPlatformSuperadmin(request)`.
- Consider `tokenVersion`/`sessionVersion` later for immediate invalidation.

Consumer impact:

Low. Affects privileged Engram APIs only.

### 10. MEDIUM — JWT verification does not explicitly pin algorithms or audience

Evidence:

- `src/lib/jwt.ts:28-44` signs HS256 tokens.
- `src/lib/jwt.ts:47-50` verifies issuer only; no explicit `algorithms` or `audience`.

Impact:

Algorithm pinning is low-cost hardening. Audience validation prevents cross-app token confusion, but the suite currently relies on shared browser SSO cookies and local JWT validation.

Recommended fix:

- Short term: pin `algorithms: ["HS256"]` during verification.
- Treat `aud` rollout as a suite contract migration.
- Consider a suite-wide `aud: "ctxhost-suite"` for browser SSO, with app-specific audiences only for native/API token exchange.

Consumer impact:

High if strict audience validation is introduced without a compatibility rollout. Audit all consumers first.

### 11. MEDIUM — Docker runtime runs as root

Evidence:

- `Dockerfile:20` starts the final runner from `node:22-alpine`.
- `Dockerfile:49` sets `ENTRYPOINT`.
- No `USER` directive exists in the runner stage.

Impact:

Any app RCE runs as root inside the container, increasing blast radius.

Recommended fix:

- Use the `node` user or create a dedicated non-root UID/GID.
- Chown only required runtime files.
- Add `USER` before `ENTRYPOINT`.

Consumer impact:

Low.

### 12. MEDIUM — Authorization-critical roles are free-form strings in the database

Evidence:

- `prisma/schema.prisma:26` uses `User.role String @default("USER")`.
- `prisma/schema.prisma:109` uses `OrgMember.role String @default("MEMBER")`.
- `prisma/schema.prisma:119` uses `OrgInvite.role String @default("MEMBER")`.
- `src/lib/authorization.ts:1-3` defines expected roles only in application code.

Impact:

Unexpected role values can be persisted by migrations, manual edits, or bugs. Authorization then depends on ad hoc string comparisons.

Recommended fix:

- Add Prisma/Postgres enums or CHECK constraints for platform and org roles.
- Normalize existing rows before adding constraints.

Consumer impact:

Low if existing data is clean.

### 13. MEDIUM — App entitlement user listing misses org entitlement gate and can expose identity fields from stale/invalid override rows

Evidence:

- `src/app/api/orgs/[orgId]/app-entitlements/[appKey]/users/route.ts:18-22` authorizes the caller for the org.
- `src/app/api/orgs/[orgId]/app-entitlements/[appKey]/users/route.ts:24-35` lists override rows and includes user email/username/displayName.
- `src/lib/user-app-entitlements.ts:32-34` says org owners/admins are limited to apps the org is already entitled to.
- This listing route does not call `ensureOrgHasAppEntitled()`.

Impact:

Org managers can list user identity fields from override rows for apps not currently enabled for the org, especially if stale rows exist or are inserted through the cross-user override bug.

Recommended fix:

- Call `ensureOrgHasAppEntitled()` before querying.
- Join/filter returned users through `OrgMember` for the same org.

Consumer impact:

Low/medium; stale invalid rows should be cleaned up.

### 14. MEDIUM — Dependency audit reported a vulnerable Next.js version

Evidence:

- `package.json:28` pins `next` to `16.1.6`.
- `package.json:46` pins `eslint-config-next` to `16.1.6`.
- A read-only sub-audit reported `npm audit` findings with a fix available around Next `16.2.6`.

Impact:

Framework-level vulnerabilities are high priority for a public auth/control-plane surface.

Recommended fix:

- Upgrade Next and eslint-config-next together.
- Rebuild, lint, typecheck, and run integration tests.
- Add dependency scanning to CI if absent.

Consumer impact:

Low unless framework upgrade changes runtime behavior.

### 15. LOW/MEDIUM — Origin-only CSRF helper is brittle when Origin is absent

Evidence:

- `src/lib/organizations.ts:92-98` returns false when `Origin` or `Cookie` is missing.
- Mutating routes rely on this helper, e.g. `src/app/api/orgs/route.ts:86-90`.

Impact:

Modern browsers usually send Origin for unsafe requests, so exploitability is lower, but this is not a complete CSRF defense for a cross-subdomain SSO service.

Recommended fix:

- Deny missing `Origin`/`Sec-Fetch-Site` for cookie-authenticated unsafe methods unless using bearer/internal auth.
- Prefer a CSRF token.

Consumer impact:

Potentially medium if suite frontends directly POST to Engram using cookies. Audit consumers first.

## Positive observations

- Internal API key comparison uses `timingSafeEqual`: `src/lib/auth.ts:24-27`.
- Refresh endpoint enforces token type: `src/app/api/auth/refresh/route.ts:50-57`.
- Password length limits protect bcrypt truncation on login/change-password: `src/app/api/auth/login/route.ts:27-33`, `src/app/api/auth/change-password/route.ts:39-44`.
- Refresh tokens are hashed before DB storage: `src/app/api/auth/login/route.ts:73-80`, `prisma/schema.prisma:134`.
- Self-service registration is disabled.
- Admin password reset blocks resetting platform superadmins and uses a transaction: `src/app/api/admin/users/[userId]/password/route.ts:65-84`.

## Recommended remediation order

1. Low-impact Engram hardening: rate limits, canonical URL guard, logout clearing, atomic refresh rotation, OAuth verified-email checks, current-role DB check for privileged APIs, Docker non-root, headers.
2. Tenant/auth correctness: per-user app entitlement target-membership checks, invalid entitlement cleanup, role constraints, CSRF protection with bearer-client compatibility.
3. Suite auth contract migration after consumer audit: remove browser access-token JSON exposure, add JWT audience compatibility rollout, consider HS256-to-JWKS ADR.

## Pending suite audit questions

For Nexus, Synapse, Thoughts, Pulse, and Plexus:

- Do they read Engram cookies directly? Which cookie names/path/domain assumptions are embedded?
- Do they require `accessToken` in Engram login or refresh JSON responses?
- Do they verify JWTs locally? Do they pin issuer, algorithm, and/or audience?
- Do they trust role/org/app entitlement claims from JWT, from Engram APIs, or from local DB copies?
- Do they make cookie-authenticated POST/PATCH/DELETE calls directly to Engram?
- Does logout depend on Engram clearing parent-domain cookies?
- Do they tolerate or depend on user-app entitlement rows for users who are not members of an org?
