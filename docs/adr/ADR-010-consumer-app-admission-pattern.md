# ADR-010: Consumer App Admission Pattern

**Status:** Accepted
**Date:** 2026-05-03
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-005 (Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements), ADR-007 (Nexus as the Tenant Workspace Consumer), ADR-009 (Per-User App Entitlements), Pulse ADR-007 (tenant isolation API lockdown), Pulse ADR-011 (no-access page)

## Context

Synapse and Pulse have each shipped a working integration that uses Engram for hosted-tenant admission. Thoughts is about to follow as the third adopter; more product apps (Axon, Dashboard, future) will follow.

The pattern has been accumulating implicitly in consumer-app code:

- Synapse's `src/lib/auth.ts` (`authenticateEngramTokenForHost`) — the original implementation.
- Pulse's `src/lib/engram-auth.ts` (`authenticateRequest`) — a more refined version with a discriminated-union AuthContext, JWT-jti caching, SUPERADMIN bypass, and structured failure reasons.

A second adopter is the right time to write the contract down. Without it, each new consumer app will rediscover the same shape (and the subtle gotchas: slug-vs-id lookup, parallel fetch ordering, fail-closed semantics, the per-user override layer added by ADR-009).

This ADR codifies the pattern. It changes no Engram code — every endpoint, response shape, and JWT field referenced here is already shipped. The purpose is to bind the contract so consumer apps and Engram cannot drift independently.

## Decisions

### D1. The 6-step admission protocol

**Decision:** Hosted product-app routes follow this sequence on every authenticated request.

1. **Read the access token** from the `engram-access` cookie, falling back to `Authorization: Bearer <token>`.
2. **Verify the token locally** with `jose.jwtVerify`, pinned to alg `HS256`, issuer `engram`, and `type: "access"`. The shared `ENGRAM_JWT_SECRET` is the only requirement — no network call.
3. **Resolve the tenant slug** from the public `Host` header (apex/control-plane hosts return null and fail closed).
4. **Fetch the user's orgs** from Engram (`GET /api/orgs`, forwarding the same token). Find the org whose `slug` matches the host slug. The user must be a member (`isMember !== false`).
5. **Verify app entitlement.** The org must have `appEntitlements[].appKey === "<this-app>"` with `enabled: true`. Per ADR-009 (shipped: migration `0008_user_app_entitlements`), each org in the response also carries `userAppOverrides: [{appKey, enabled}]` for the authenticated user; an explicit `enabled: false` row for this app denies admission. Absence of an override means default-allow.
6. **Resolve or provision the local projection** of the user/org/membership in the consumer app's database. Return a structured `AuthContext` for routes to consume, or a structured failure on any miss.

This sequence is the only authoritative admission path. Routes do not derive tenancy from cookies, request bodies, query strings, or stale local preferences — only from the host-derived slug confirmed against Engram membership.

### D2. JWT shape Engram commits to

**Decision:** Engram-issued access tokens carry, at minimum:

- `iss: "engram"`
- `type: "access"` (refresh tokens are explicitly rejected by consumers)
- `userId: string`
- `role?: string` — the Engram account role. The schema enum is `USER | ADMIN`; the literal string `"SUPERADMIN"` is used for platform superadmins (resolved via `isPlatformSuperadmin` in Engram, not the schema enum). Consumers should match on the literal `"SUPERADMIN"` for the bypass in D8.
- `jti: string` (consumers may use this as a cache key for the orgs response)
- `exp: number` (consumers may use this to bound cache TTL)

Algorithm is pinned to HS256. Consumers MUST verify alg explicitly to defeat alg=none attacks. The token does NOT carry org membership, app entitlements, or per-user overrides — those are resolved per request via `/api/orgs` so revocations take effect immediately rather than waiting for the next 15-minute token refresh.

### D3. Engram API contract for admission

**Decision:** Engram exposes the following endpoints for consumer-app admission. These are stable; breaking changes require a new ADR.

`GET /api/users/me`
- Auth: `engram-access` cookie or `Authorization: Bearer`.
- Returns: `{ user: { id, username, displayName, email, emailVerified, avatarUrl, role, ... } }`.
- Used by consumers for first-touch user provisioning (display name, email, avatar).

`GET /api/orgs`
- Auth: same as above.
- Returns: `{ organizations: [{ id, slug, name, role, isMember, appEntitlements: [{appKey, enabled}], userAppOverrides: [{appKey, enabled}], ... }] }`.
- Returns ONLY orgs the authenticated user is a member of (via the `OrgMember` join in Engram). `isMember` is informational; absence from the array is the authoritative non-membership signal.
- `userAppOverrides` (added by ADR-009, shipped via migration `0008_user_app_entitlements`) lists the authenticated user's explicit per-(org, app) overrides for THIS org. The shape is per-org array, not flat tuples, since the parent org provides the orgId context. Consumers should treat its absence as "no overrides" (default-allow).

These endpoints are fetched in parallel (`Promise.all`) because they share the same auth and have no dependency between them.

### D4. Tenant slug resolution rules

**Decision:** The host-derived slug is the only authoritative tenant boundary. Consumer apps:

- Read the public `Host` header. Prefer `Host` over `x-forwarded-host` so client-supplied forwarded headers cannot move or hide a tenant boundary; consult `x-forwarded-host` only on trusted reverse-proxy paths where the app sees an internal `Host` and the proxy overwrites forwarded headers.
- Strip the suite suffix (`.dev.ctxhost.com` for dev, `.ctxhost.com` for prod). The remaining label is the slug candidate.
- Reject the apex (`dev.ctxhost.com`, `ctxhost.com`) and the control-plane subdomains (`login.*`, `platform.*`) as tenant slugs. These should never resolve to a tenant.
- Validate the slug against `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` (DNS-label-safe).
- Do NOT trust client cookies, request bodies, query strings, or local storage as the slug source.

A request without a resolvable slug fails closed with `no_matching_org` (or `missing_token` if the user wasn't authenticated to begin with).

Pulse's `tenant-host.ts` does not currently reject `login`/`platform` slugs — only Synapse's host parser does. Pulse should converge on the stricter rule; tracked under Consequences below.

### D5. Local projection lookup is keyed by slug, not by id

**Decision:** When a consumer upserts its local `Organization` projection on first admission, it MUST key by `slug`, not by Engram's `id`.

**Rationale:** Each Engram environment (AWS dev, on-prem-host, future prod) issues its own org IDs. The same `cortex` org is a different cuid2 in dev vs prod. Slug-keyed lookup makes consumer-app data portable across environments and stays correct under reseed/restore. The Engram org id may still be stored on the projection row (e.g., Pulse's `Tenant.engramOrgId @unique`), but it is not the lookup key.

This is the lesson Synapse learned: `prisma.organization.upsert({ where: { slug } })` is the canonical shape.

### D6. Failure states use a structured `AuthFailureReason`

**Decision:** Consumer apps return a structured failure reason on any admission miss. Canonical enum:

| Reason | Meaning | Suggested UX |
|---|---|---|
| `missing_token` | No cookie and no Bearer header | Redirect to Engram `/api/auth/continue` |
| `invalid_token` | Token verify failed (bad sig, expired, wrong issuer/type) | Redirect to Engram `/api/auth/continue` |
| `no_matching_org` | Host slug didn't match any of the user's orgs | Show "no access" page |
| `missing_entitlement` | Org has no `enabled: true` row for this app | Show "app not enabled for this tenant" page |
| `member_unprovisioned` | Tenant doesn't exist locally and the caller isn't OWNER/ADMIN to provision it | Show "ask an admin" page |
| `user_app_revoked` | Per-user override has `enabled: false` (ADR-009) | Show "revoked — ask OWNER/ADMIN" page |

Pulse's live enum (`pulse/src/lib/engram-auth.ts`) carries the first five reasons today. The sixth (`user_app_revoked`) is introduced by ADR-009 and is not yet adopted by either Synapse or Pulse — this ADR makes the value canonical going forward so the next adopter (Thoughts) and future migrations land on the agreed name.

Apps SHOULD distinguish these reasons in the UI (Pulse ADR-011 specifies the planned `/pulse/no-access?reason=…` page; Pulse hasn't shipped that route yet but the routing model is the reference). Apps MUST NOT redirect-loop on a fail — fail closed to a terminal state.

### D7. Per-jti caching of the orgs response is recommended

**Decision:** Consumer apps SHOULD cache the `/api/orgs` response in-process keyed by JWT `jti`, with TTL bounded by `min(payload.exp, now + 15min)`.

**Rationale:** The orgs endpoint is on every admission hot path. The JWT `jti` changes on every token rotation (15-minute access-token TTL), so the cache invalidates naturally without explicit revocation signaling. Pulse already does this (`engram-auth.ts` `orgsCache`). Apps that do not need the optimization may skip it, but high-traffic apps will want it.

For consumers that adopt ADR-009's per-user overrides: the override list is fetched in the same response, so a single cache entry covers both.

### D8. SUPERADMIN bypasses tenant scoping

**Decision:** A user whose JWT carries `role: "SUPERADMIN"` is admitted regardless of tenant membership or app entitlement. The consumer's `AuthContext` carries a distinct `superadmin: true` discriminant so route logic can branch where appropriate.

**Rationale:** Consistent with every other access control in the suite (project memory `feedback_superadmin_access`). SUPERADMINs are platform staff debugging across tenants; gating them on tenant entitlement would defeat their purpose.

ADR-009's per-user override is no exception — a SUPERADMIN with their own `enabled: false` row still gets through. The row exists for audit completeness only.

### D9. Discriminated-union `AuthContext` is the recommended return shape

**Decision:** Consumer apps SHOULD return a discriminated union from their admission helper:

```ts
type AuthContext =
  | { authenticated: true; superadmin: true; userId; role: "SUPERADMIN"; tenantId: string | null; tenantSlug: string | null }
  | { authenticated: true; superadmin: false; userId; role; orgId; orgRole: "OWNER"|"ADMIN"|"MEMBER"; tenantId; tenantSlug }
  | { authenticated: false; reason: AuthFailureReason };
```

This forces routes to handle each variant explicitly and prevents the "what if `tenantId` is null on a non-SUPERADMIN" class of bugs. Pulse's `AuthContext` is the canonical shape.

### D10. Provisioning happens in a transaction

**Decision:** First-touch provisioning of `User`, `Organization`/`Tenant`, and `OrgMember` rows MUST happen in a single database transaction. Partial provisioning would leave the consumer in an inconsistent state on retry.

**Rationale:** Synapse's `provisionEngramUserForTenant` uses `prisma.$transaction(async (tx) => { ... })`. Pulse's `resolveOrProvisionTenant` uses a single `prisma.tenant.create` keyed off Engram's org id. Both are correct because each provisions only one row. Multi-row provisioning (User + Org + OrgMember together, as in Synapse) requires the transaction.

### D11. Apps MUST NOT silently fall back to demo data in hosted mode

**Decision:** When `ENGRAM_URL` and `ENGRAM_JWT_SECRET` are configured (i.e., hosted mode), any admission failure produces an explicit closed state — never synthetic success, demo data, or a fallback "default" org.

A local-dev convenience escape hatch (e.g. Pulse's `PULSE_TENANCY_ENFORCED` toggle, defaulting to off in dev) is allowed but MUST be off-by-default in any environment that has Engram configured. New consumer apps should follow a generalized naming convention `<APP>_HOSTED_ENFORCED` or similar. A production-shaped env with the toggle off is a deploy bug.

This rule comes from the suite-wide multi-tenancy pattern (`cortex-mesh/docs/architecture/product-app-multi-tenancy-pattern.md` rule 5: "Hosted mode fails closed").

## Quick Start for new consumer apps

A new consumer app integrating Engram admission needs roughly five files. Mirror Pulse's shape:

1. **`src/lib/engram-jwt.ts`** (~45 lines) — `verifyEngramToken(token)` using `jose.jwtVerify`. Export `ENGRAM_COOKIE_NAME = "engram-access"`.
2. **`src/lib/engram-client.ts`** (~35 lines) — `fetchEngramOrgs(token)` calling `GET /api/orgs`. Read `ENGRAM_URL` env. Type the response shape.
3. **`src/lib/tenant-host.ts`** (~30 lines) — `tenantSlugFromHost(hostHeader)` implementing D4.
4. **`src/lib/engram-auth.ts`** (~150 lines) — the `authenticateRequest(req) → AuthContext` implementation following D1–D10. Add SUPERADMIN bypass (D8) and per-jti orgs cache (D7).
5. **`src/lib/projections.ts`** OR equivalent (~80 lines) — slug-keyed upsert helpers (D5) in a transaction (D10).

Register the app in Engram's `APP_KEYS` (`engram/src/lib/authorization.ts`) if it isn't already there. Then use the SUPERADMIN console (ADR-006) to enable the app entitlement on each tenant org that should have access.

Reference implementation files:
- Pulse — `/pulse/src/lib/engram-auth.ts`, `/pulse/src/lib/engram-client.ts`, `/pulse/src/lib/engram-jwt.ts`, `/pulse/src/lib/tenant-host.ts`
- Synapse (older but battle-tested provisioning logic) — `/synapse/src/lib/auth.ts` (`authenticateEngramTokenForHost`, `provisionEngramUserForTenant`, `syncTenantMembership`)

## Engram-side commitments

This ADR commits Engram to:

1. Stable `/api/users/me` and `/api/orgs` response shapes per D3. Additive changes (new fields) are non-breaking; renamed/removed fields require a new ADR with a deprecation window.
2. Stable JWT shape per D2. Algorithm changes require a new ADR.
3. Stable `engram-access` cookie name and cookie-or-Bearer auth.
4. Maintaining the `APP_KEYS` registry (`src/lib/authorization.ts`) as the source of truth for valid app keys.

What Engram does NOT commit to:
- A specific failure response body shape on these endpoints (consumers should trust HTTP status only).
- Specific per-app entitlement defaults — orgs start with no entitlements; SUPERADMIN explicitly enables apps per tenant.
- Real-time push of revocation events. Revocations land on the next admission cycle (within the JWT lifetime, bounded by D7's cache TTL).

## What this ADR does NOT do

- Does not require any code change in Engram. Every endpoint, JWT field, and response shape referenced here exists today.
- Does not specify how consumer apps store local user/org data — slug-keyed lookup (D5) is the only constraint. Apps may use either an id-equals-Engram-id projection (Thoughts), an `engramOrgId @unique` bridge on a Pulse-style `Tenant` model (Pulse), or `Organization`/`OrgMember` rows directly (Synapse).
- Does not cover realtime/WebSocket admission — Synapse's WebSocket auth is out of scope; a future ADR can extend.
- Does not cover native app PKCE auth — that's ADR-002.
- Does not change the per-user-override semantics of ADR-009; this ADR references them as a contract that consumers must honor.
- Does not mandate per-jti caching (D7) — apps may skip it if their traffic doesn't warrant the optimization.

## Consequences

### Positive

- New consumer apps have a single document to read instead of reverse-engineering Synapse and Pulse.
- The contract is explicit, so additive changes to Engram (new response fields, new failure modes) can be discussed against the ADR rather than emerging silently.
- Slug-keyed projection lookup (D5) eliminates the cross-environment id-mismatch class of bugs.
- Discriminated `AuthContext` (D9) makes route-level handling type-safe.
- The structured failure-reason vocabulary (D6) lets the suite present coherent UX across apps.

### Negative

- Two existing consumers (Synapse, Pulse) are not perfectly aligned with each other today. Each will need follow-up work to converge on the documented pattern. Specific known gaps:
  - Synapse does not return a structured `AuthFailureReason` (uses a `failureReason: "engram_user_not_linked"` single-value field instead).
  - Pulse's `tenant-host.ts` does not reject `login`/`platform` slugs (D4).
  - Neither Synapse nor Pulse honors `userAppOverrides` yet (D6's `user_app_revoked`).
  - Pulse's no-access page (ADR-011) is not yet shipped — UX routing matrix exists in spec only.
- Future endpoint additions to Engram must explicitly state whether they're "admission-path stable" or experimental, since this ADR raised the bar.

### Risks

- **Drift between this ADR and the live Synapse/Pulse code.** Mitigated by linking the reference implementations and by treating the next consumer (Thoughts) as a conformance test — if Thoughts can't follow the documented steps, the ADR is wrong, not Thoughts.
- **Per-user override rollout (ADR-009) lands later.** Until ADR-009's API change ships, consumers ignoring `userAppOverrides` is correct (the field will simply be absent). After it ships, consumers MUST honor it; this ADR makes that obligation explicit.

## Links

- ADR-001: Engram identity service — `docs/adr/ADR-001-engram-identity-service.md`
- ADR-005: Org-level app + feature entitlements — `docs/adr/ADR-005-suite-roles-org-roles-and-app-entitlements.md`
- ADR-007: Nexus tenant shell boundary — `docs/adr/ADR-007-nexus-tenant-shell-boundary.md`
- ADR-009: Per-user app entitlements — `docs/adr/ADR-009-per-user-app-entitlements.md`
- Suite-wide multi-tenancy pattern — `../../cortex-mesh/docs/architecture/product-app-multi-tenancy-pattern.md`
- Pulse reference impl — `../../pulse/src/lib/engram-auth.ts`
- Synapse reference impl — `../../synapse/src/lib/auth.ts`
- Pulse ADR-007 (tenant isolation): `../../pulse/docs/adr/ADR-007-tenant-isolation-api-lockdown.md`

## Amendment Notes

- 2026-05-04: Cortex ADR-075 renamed the `rocky` deployment profile to `on-prem`. The D5 rationale above lists "Each Engram environment (AWS dev, on-prem-host, future prod)" — read this as **(AWS dev, on-prem, future prod)** going forward. The body is left as-written so the historical decision record stays intact. New prose in this ADR uses `on-prem`.
