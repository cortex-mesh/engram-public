# Suite Auth Consumer Audit — 2026-05-20

Status: checkpoint
Owner repo: Engram, because Engram owns the auth/cookie/JWT contract
Scope: Nexus, Synapse, Thoughts, Pulse, Plexus as Engram consumers
Reviewer: Hermes

## Purpose

This document records how hosted suite applications currently consume Engram authentication so Engram security hardening can be sequenced without breaking the suite.

Primary question: which Engram fixes affect consumer applications?

## Executive summary

Across Nexus, Synapse, Thoughts, Pulse, and Plexus:

- All audited browser consumers depend on the `engram-access` cookie reaching their host/path.
- None of the audited consumers appears to depend on Engram `/api/auth/login` or `/api/auth/refresh` JSON returning `accessToken`.
- All audited consumers locally verify Engram JWTs using `ENGRAM_JWT_SECRET`, issuer `engram`, and HS256.
- None currently validates JWT audience.
- Nexus, Synapse, Thoughts, and Pulse depend on Engram `/api/orgs` response shape and app entitlement semantics.
- Plexus does not consume org/app entitlements for admission; it admits platform operators via `SUPERADMIN` role in the JWT.
- Synapse and Nexus have logout paths that POST to Engram `/api/auth/logout` with cookies and may break if Engram adds CSRF requirements without a server/browser-compatible logout contract.
- Thoughts, Pulse, and Plexus do not appear to make cross-origin cookie-authenticated POSTs to Engram.

## Compatibility matrix

| Engram change | Nexus | Synapse | Thoughts | Pulse | Plexus | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Remove `accessToken` from browser login JSON | likely safe | likely safe | likely safe | likely safe | likely safe | No direct `/api/auth/login` JSON consumers found. |
| Remove/change cookie-based `engram-access` browser SSO | breaks | breaks | breaks | breaks | breaks | All rely on this cookie. |
| Change `engram-access` name/domain/path so app hosts do not receive it | breaks | breaks | breaks | breaks | breaks | Keep compatibility or update all consumers first. |
| Change refresh cookie semantics | indirect | indirect | likely safe | likely safe | likely safe | Consumers do not read `engram-refresh`; continue/session renewal may depend on Engram. |
| Add JWT `aud` claim but do not require consumers to validate it | safe | safe | safe | safe | safe | Consumers ignore audience today. |
| Require consumers to validate JWT `aud` | breaks until updated | breaks until updated | breaks until updated | breaks until updated | breaks until updated | Needs compatibility rollout. |
| Change JWT issuer or algorithm | breaks | breaks | breaks | breaks | breaks | All pin issuer `engram` and HS256. |
| Rotate `ENGRAM_JWT_SECRET` without coordination | breaks | breaks | breaks | breaks | breaks | All use local shared-secret verification. |
| Move to RS256/JWKS | breaks until updated | breaks until updated | breaks until updated | breaks until updated | breaks until updated | Should be an ADR/migration. |
| Add CSRF to Engram logout POST only | risk | risk | likely safe | likely safe | likely safe | Nexus/Synapse call logout; others do not. |
| Add CSRF to all Engram cookie-authenticated POSTs | risk | risk | likely safe | likely safe | likely safe | Need server-to-server/logout-compatible path. |
| Tighten `/api/orgs` shape or entitlement semantics | risk | risk | risk | risk | low | Nexus/Synapse/Thoughts/Pulse consume org/app entitlements. |

## Nexus

Repo: `/Users/roland/Projects/cortex-mesh/nexus`

### Findings

1. Nexus has a hard dependency on the `engram-access` cookie.

Evidence:

- `src/lib/auth.ts:5,53-58` reads only `engram-access` and verifies it locally.
- `src/app/(shell)/layout.tsx:27-34` redirects to Engram continue when there is no valid session.
- `src/lib/tenant-context.ts:95-114` requires the access token and calls Engram `/api/orgs` with a manual `Cookie: engram-access=...` header.

Impact:

Changing cookie name, domain, path, or delivery to tenant hosts breaks Nexus login/session behavior.

2. No direct dependency on `/api/auth/login` or `/api/auth/refresh` JSON `accessToken` was found.

Evidence:

- Search found no source use of `/api/auth/login`, `/api/auth/refresh`, or access-token JSON handling.
- Login is delegated by redirect to `/api/auth/continue`: `src/lib/auth.ts:61-63`.

Impact:

Removing browser login JSON `accessToken` should not break Nexus if `/api/auth/continue` still issues cookies and redirects correctly.

3. Nexus verifies JWTs locally with shared HS256 secret, issuer `engram`, and no audience.

Evidence:

- `src/lib/auth.ts:6` hardcodes issuer `engram`.
- `src/lib/auth.ts:8-13` reads `ENGRAM_JWT_SECRET`.
- `src/lib/auth.ts:30-33` calls `jwtVerify` with issuer and `algorithms: ["HS256"]`.
- No audience check is present.

Impact:

Issuer/algorithm/secret/JWKS changes break Nexus until code is updated. Adding an `aud` claim is safe today, but requiring Nexus to validate it needs a rollout.

4. Nexus trusts org/app entitlement data from Engram `/api/orgs`.

Evidence:

- `src/lib/tenant-context.ts:108-114` calls `/api/orgs` with the Engram cookie.
- `src/lib/tenant-context.ts:130-147` authorizes the current host by organization slug.
- `src/lib/tenant-context.ts:205-214` maps app entitlements into `enabledApps`.
- `src/lib/apps.ts:64-76` enables launcher apps from `appEntitlements` entries.

Impact:

Changing `/api/orgs` shape, org slug semantics, or app entitlement semantics breaks Nexus workspace authorization/launcher behavior.

5. Nexus logout assumes Engram cookie logout remains a simple POST.

Evidence:

- `src/app/api/auth/logout/route.ts:4-11` clears expected Engram cookie names/paths.
- `src/app/api/auth/logout/route.ts:68-83` POSTs to Engram `/api/auth/logout` with filtered Engram cookies.
- `src/app/api/auth/logout/route.ts:84-95` ignores Engram logout failure and redirects locally.

Impact:

If Engram logout requires CSRF or changes path/method, Nexus may appear logged out locally while Engram cookies remain valid.

## Synapse

Repo: `/Users/roland/Projects/cortex-mesh/synapse`

### Findings

1. Synapse consumes only `engram-access`, including for WebSocket auth.

Evidence:

- `src/lib/engram-jwt.ts:44` defines `ENGRAM_COOKIE_NAME = "engram-access"`.
- `src/lib/auth.ts:278-292` authenticates HTTP requests from the access cookie.
- `server.ts:87-94` authenticates WebSocket upgrades from the access cookie.
- No `engram-refresh` source references were found.

Impact:

Access-cookie name/domain/path changes break HTTP and WebSocket auth. Refresh-cookie changes are indirect via Engram continue/session renewal.

2. Synapse does not depend on login/refresh JSON `accessToken`.

Evidence:

- No source calls to Engram `/api/auth/login` or `/api/auth/refresh` were found.
- `src/app/login/page.tsx:40-41` redirects to Engram continue.
- `src/lib/engram-links.ts:23-24` builds `/api/auth/continue?redirect_uri=...`.
- `src/hooks/useSynapseSocket.ts:97-130` uses a hidden iframe to `/api/auth/continue` for session recovery.

Impact:

Removing browser login JSON `accessToken` should not break Synapse. Changing `/api/auth/continue`, iframe behavior, or cookie behavior can break session recovery.

3. Synapse verifies JWTs locally with shared HS256 secret, issuer `engram`, no audience.

Evidence:

- `src/lib/engram-jwt.ts:3` sets issuer `engram`.
- `src/lib/engram-jwt.ts:32-35` verifies with issuer and `algorithms: ["HS256"]`.
- `src/lib/engram-jwt.ts:36` requires token type `access`.
- No audience check is present.

Impact:

Issuer/algorithm/secret/JWKS changes break Synapse until updated. Audience rollout requires consumer changes.

4. Synapse trusts `/api/orgs` app entitlement data.

Evidence:

- `src/lib/auth.ts:588-594` calls Engram `/api/users/me` and `/api/orgs` with `Cookie: engram-access=...`.
- `src/lib/auth.ts:606-610` selects org by slug and checks Synapse entitlement.
- `src/lib/auth.ts:630-636` requires `appKey === "synapse"` and `enabled === true`.
- `src/lib/auth.ts:563-575` syncs local org membership/role from Engram.

Impact:

Changing `/api/orgs` shape, org slug semantics, app key, role semantics, or entitlement booleans breaks hosted tenant access/provisioning.

5. Synapse logout POST may need a new contract if Engram adds CSRF.

Evidence:

- `src/lib/synapse-client.ts:679-685` POSTs to `${engramUrl}/api/auth/logout` with `credentials: "include"`.
- `src/lib/synapse-client.ts:686-689` ignores logout failures and redirects locally.

Impact:

If Engram logout requires a CSRF token/header, Synapse may fail to clear Engram cookies and silently re-authenticate.

## Thoughts

Repo: `/Users/roland/Projects/cortex-mesh/thoughts`

### Findings

1. Thoughts reads `engram-access` with Bearer fallback, and does not use `engram-refresh`.

Evidence:

- `src/lib/engram-jwt.ts:10` defines the access cookie.
- `src/lib/engram-auth.ts:77-83` reads cookie/Bearer auth.
- `src/lib/request-like.ts:10-23` supports request-like cookie/header access.
- `src/lib/engram-jwt.ts:12-16` and `src/lib/engram-jwt.ts:31-37` reject non-access token types.

Impact:

Changing access cookie delivery breaks browser auth. Refresh cookie changes are likely safe for Thoughts.

2. Thoughts verifies JWTs with shared HS256 secret, issuer `engram`, no audience.

Evidence:

- `src/lib/engram-jwt.ts:18-25` reads `ENGRAM_JWT_SECRET` and sets verification parameters.
- `src/lib/engram-jwt.ts:31-35` verifies issuer/HS256 without audience.

Impact:

Issuer/algorithm/secret/JWKS changes break Thoughts. Audience rollout needs a code change.

3. Thoughts trusts `/api/orgs` app entitlements and user overrides.

Evidence:

- `src/lib/engram-client.ts:47-58` calls `/api/orgs` with `Authorization: Bearer <access token>`.
- `src/lib/engram-auth.ts:264-278` maps org data.
- `src/lib/engram-auth.ts:101-116` and `src/lib/engram-auth.ts:269-274` require `appKey=thoughts`, `enabled=true`, and honor `userAppOverrides enabled=false`.
- `src/lib/engram-auth.ts:220-233` has a SUPERADMIN bypass.

Impact:

Changing `/api/orgs` shape or entitlement semantics breaks Thoughts admission. Tightening invalid user override rows in Engram is correct but should include data cleanup.

4. No direct login/refresh JSON or cross-origin cookie POST dependency was found.

Evidence:

- `src/lib/server-page-guard.ts:31-38` and `src/lib/server-action-guard.ts:72-85` redirect/deny locally.
- `src/lib/engram-client.ts:51-55` and `src/lib/engram-client.ts:65-69` use server-side Bearer GETs to Engram.

Impact:

Removing browser login JSON `accessToken` and adding CSRF to Engram POSTs should not directly break Thoughts.

## Pulse

Repo: `/Users/roland/Projects/cortex-mesh/pulse`

### Findings

1. Pulse reads `engram-access` with Bearer fallback and does not use `engram-refresh`.

Evidence:

- `src/lib/engram-jwt.ts:35` defines the access cookie.
- `src/lib/engram-auth.ts:57-66` reads access token from cookie/header.
- `src/lib/server-tenant.ts:81-90` uses auth for tenant context.
- `src/middleware.ts:29-51` gates page routes by `engram-access` and redirects to Engram continue.
- `src/lib/engram-jwt.ts:13-17` and `src/lib/engram-jwt.ts:23-28` reject refresh tokens.

Impact:

Changing access cookie delivery breaks page/API auth. Refresh-cookie changes are likely safe if continue flow still works.

2. Pulse verifies JWTs with shared HS256 secret, issuer `engram`, no audience.

Evidence:

- `src/lib/engram-jwt.ts:3-10` configures issuer/secret.
- `src/lib/engram-jwt.ts:23-26` verifies issuer/HS256 without audience.

Impact:

Issuer/algorithm/secret/JWKS changes break Pulse. Audience rollout needs a code change.

3. Pulse trusts `/api/orgs` app entitlement data.

Evidence:

- `src/lib/engram-client.ts:27-40` calls `/api/orgs` with `Authorization: Bearer <access token>`.
- `src/lib/engram-auth.ts:237-248` maps org data.
- `src/lib/engram-auth.ts:92-97`, `src/lib/engram-auth.ts:111-116`, and `src/lib/engram-auth.ts:247-252` require `appKey=pulse`, `enabled=true`, and honor user overrides.
- `src/lib/engram-auth.ts:198-217` has a SUPERADMIN/default-tenant bypass path.

Impact:

Changing `/api/orgs` shape or entitlement semantics breaks Pulse tenant admission/provisioning.

4. No direct login/refresh JSON or cross-origin cookie POST dependency was found.

Evidence:

- Pulse redirects to `/api/auth/continue` and uses server-side Bearer GETs to Engram.
- `src/lib/engram-client.ts:31-35` sends `Authorization: Bearer <token>`.

Impact:

Removing browser login JSON `accessToken` and adding CSRF to Engram POSTs should not directly break Pulse.

## Plexus

Repo: `/Users/roland/Projects/cortex-mesh/plexus`

### Findings

1. Plexus reads `engram-access` only and rejects refresh tokens.

Evidence:

- `src/lib/auth.ts:4` defines the access cookie name.
- `src/lib/auth.ts:41-44` reads `engram-access`.
- `src/lib/auth.ts:52-53` rejects non-access token types.

Impact:

Changing access cookie delivery breaks Plexus auth. Refresh-cookie changes are likely safe.

2. Plexus verifies JWTs with shared HS256 secret, issuer `engram`, no audience.

Evidence:

- `src/lib/auth.ts:7-10` reads `ENGRAM_JWT_SECRET`.
- `src/lib/auth.ts:12-18` configures issuer and secret.
- `src/lib/auth.ts:46-50` verifies issuer/HS256 without audience.

Impact:

Issuer/algorithm/secret/JWKS changes break Plexus. Audience rollout needs a code change.

3. Plexus admission uses SUPERADMIN role, not org/app entitlements.

Evidence:

- `src/lib/auth.ts:28-32` defines admin role checks.
- `src/lib/auth.ts:82-84` requires SUPERADMIN session.
- `src/app/(shell)/layout.tsx:33-35` redirects if no operator session.
- `src/lib/internal-auth.ts:32-38` allows SUPERADMIN for API internal auth fallback.
- No `/api/orgs` consumer was found.

Impact:

Changing entitlement semantics has low Plexus impact. Changing platform role claim semantics or removing role from JWT breaks Plexus operator admission.

4. Plexus enriches user info by forwarding the Engram cookie to `/api/users/me`.

Evidence:

- `src/lib/auth.ts:60-67` calls Engram `/api/users/me` with `Cookie: engram-access=...`.

Impact:

If Engram stops accepting raw Cookie forwarding for this GET, display-name/user enrichment may break while base JWT auth still works. Prefer Bearer for server-to-server calls.

5. No direct login/refresh JSON or cross-origin cookie POST dependency was found.

Evidence:

- `src/lib/auth.ts:90-105` builds login/continue redirects.
- `src/app/(shell)/layout.tsx:17-30` redirects to Engram when unauthenticated.

Impact:

Removing browser login JSON `accessToken` and adding CSRF to Engram POSTs should not directly break Plexus.

## Recommended rollout based on consumer audit

### Safe to do now with low suite break risk

- Remove `accessToken` from Engram browser login JSON, if confirmed by a final grep in all repos during implementation.
- Add Engram rate limiting.
- Require/validate production `ENGRAM_URL`.
- Fix logout cookie clearing while preserving existing cookie names/domain/path.
- Make refresh rotation atomic without changing response shape.
- Require verified OAuth email before linking.
- Run Engram as non-root.
- Add security headers.
- Re-read current DB role for Engram privileged APIs.

### Do now, but coordinate with data cleanup/tests

- Fix Engram per-user app entitlement target membership checks.
- Add a report/migration for `UserAppEntitlement` rows without matching `OrgMember`.
- Keep `/api/orgs` response shape stable while tightening invalid data.

### Needs compatibility migration/ADR

- JWT audience validation.
  - Phase 1: Engram emits `aud` while consumers ignore it.
  - Phase 2: update consumers to accept expected `aud` plus missing-aud compatibility.
  - Phase 3: require `aud` after all consumers deploy.
- HS256 shared-secret to RS256/JWKS migration.
  - Requires consumer verifier changes and key rotation semantics.
- Cookie contract changes.
  - Any cookie name/domain/path/SameSite change must be suite-wide and staged.
- CSRF requirements for Engram logout POST.
  - Need an Engram logout redirect endpoint, CSRF-token acquisition, server credential, or compatibility exemption before enforcing.

## Immediate PR suggestions

1. Engram hardening PR 1: rate limit + ENGRAM_URL production guard + OAuth verified-email checks.
2. Engram hardening PR 2: logout cookie clearing + atomic refresh rotation + no browser login `accessToken` after final grep.
3. Engram tenant isolation PR: target membership checks for user app entitlements + invalid override report.
4. Consumer hardening PRs: add JWT audience support in Nexus/Synapse/Thoughts/Pulse/Plexus in compatibility mode.
5. ADR: suite JWT key/audience migration, covering HS256 rotation and future JWKS.
