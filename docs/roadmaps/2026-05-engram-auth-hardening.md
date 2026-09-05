# Engram Auth Hardening Roadmap — 2026-05

Status: Proposed
Owner: Engram
Related: [Engram security audit checkpoint](../security-audit-2026-05-20.md), [suite auth consumer audit](../suite-auth-consumer-audit-2026-05-20.md), [ADR-010](../adr/ADR-010-consumer-app-admission-pattern.md), [ADR-012](../adr/ADR-012-suite-jwt-audience-validation.md), [ADR-013](../adr/ADR-013-browser-sso-cookie-and-csrf-contract.md), [ADR-014](../adr/ADR-014-jwt-signing-key-distribution.md)

## Goal

Harden Engram as the identity root for the hosted suite without breaking Nexus, Synapse, Thoughts, Pulse, or Plexus.

This roadmap turns the May 2026 audit findings into staged implementation work. It deliberately separates low-risk Engram-local hardening from suite-wide auth contract migrations.

## Current state from audit

The audit found these suite-wide invariants:

- All audited browser consumers depend on the `engram-access` cookie reaching their host/path.
- None of Nexus, Synapse, Thoughts, Pulse, or Plexus appears to depend on `/api/auth/login` or `/api/auth/refresh` JSON returning `accessToken`.
- All audited consumers locally verify Engram access JWTs using `ENGRAM_JWT_SECRET`, issuer `engram`, HS256, and no audience validation.
- Nexus, Synapse, Thoughts, and Pulse depend on `/api/orgs` and app entitlement semantics.
- Nexus and Synapse have logout paths that POST to Engram `/api/auth/logout` with cookies and need a compatible logout/CSRF contract before Engram can enforce stricter CSRF on logout.

## Phase 0 — Documentation and project setup

Status: In progress

Deliverables:

- Security audit checkpoint: `docs/security-audit-2026-05-20.md`.
- Suite consumer audit: `docs/suite-auth-consumer-audit-2026-05-20.md`.
- Architecture decisions:
  - ADR-012 — suite JWT audience validation.
  - ADR-013 — browser SSO cookie/logout/CSRF contract.
  - ADR-014 — JWT signing key distribution and future JWKS migration.
- This roadmap.
- Optional Thoughts project to track implementation slices across Engram and consumers.

## Phase 1 — Engram-local hardening, no suite contract change

Status: Not started
Risk: Low/medium

Target PRs:

### PR 1.1 — Rate limiting and canonical URL guard

Scope:

- Add centralized rate limiting for:
  - `POST /api/auth/login`
  - `POST /api/auth/magic-link`
  - `POST /api/auth/refresh`
  - `POST /api/auth/token`
- Add production startup/runtime validation for `ENGRAM_URL`:
  - required in production
  - HTTPS only in production
  - no localhost/default placeholder in production
- Stop deriving magic-link and OAuth public callback URLs from untrusted Host/X-Forwarded headers in production.

Validation:

- Unit tests for rate-limit keys and bypass-free production behavior.
- Route tests for 429 behavior.
- Regression tests for magic-link/OAuth URL base selection.
- `npm run lint`
- `npm run build`

### PR 1.2 — OAuth verified-email account linking

Scope:

- Google: require verified email from ID token or verified userinfo claim before email-based linking.
- GitHub: always fetch `/user/emails`; choose primary verified email for linking.
- Refuse email-based linking when verified email cannot be established.

Validation:

- Tests for verified and unverified Google/GitHub responses.
- Tests that existing linked OAuthAccount by provider/account id still signs in.
- `npm run lint`
- `npm run build`

### PR 1.3 — Refresh/logout hardening without response-shape changes

Scope:

- Make refresh-token rotation atomic.
- Preserve current cookie/body response shapes.
- Clear logout cookies with the same domain/path/SameSite/secure attributes used when setting them.
- Add shared helpers for set/clear access and refresh cookies.

Validation:

- Tests for concurrent refresh consume behavior where practical.
- Tests for domain-aware cookie clearing.
- Verify Nexus/Synapse logout still works.
- `npm run lint`
- `npm run build`

### PR 1.4 — Privileged-role freshness and runtime hardening

Scope:

- Add `requireCurrentPlatformSuperadmin(request)` for privileged Engram admin APIs.
- Re-read current user role from DB for high-risk APIs.
- Add security headers/no-store for sensitive responses.
- Run Docker runtime as non-root.

Validation:

- Tests showing demoted superadmin JWT no longer authorizes privileged APIs.
- Docker build smoke.
- `npm run lint`
- `npm run build`

### PR 1.5 — Remove browser login `accessToken` JSON exposure

Scope:

- Remove `accessToken` from browser login JSON response.
- Keep native/API token behavior in `/api/auth/token`.
- Decide whether cookie-source refresh should still return `accessToken`; if changed, do a final consumer grep first.

Validation:

- Final grep across Nexus, Synapse, Thoughts, Pulse, Plexus for `/api/auth/login`, `/api/auth/refresh`, and response `accessToken` use.
- Browser login flow smoke in AWS-dev.
- Nexus/Synapse/Thoughts/Pulse/Plexus login smoke where feasible.

## Phase 2 — Tenant isolation and data correctness

Status: Not started
Risk: Medium

Target PRs:

### PR 2.1 — User app entitlement membership invariant

Scope:

- Require target user membership in `orgId` before GET/PUT/DELETE per-user app entitlement overrides.
- Return 404 for non-members.
- Ensure app-entitlement user listing calls the org app entitlement gate.
- Filter returned users through `OrgMember` for the same org.

Validation:

- Tests for org owner/admin cannot create override for a non-member.
- Tests for GET/DELETE non-member behavior.
- Tests for stale invalid rows not being exposed in listing.
- `npm run lint`
- `npm run build`

### PR 2.2 — Invalid entitlement cleanup report

Scope:

- Add an operator script/report for `UserAppEntitlement` rows without matching `OrgMember(userId, orgId)`.
- Decide whether to delete, quarantine, or leave invalid rows after review.

Validation:

- Dry-run output in dev/test database.
- No destructive default behavior.

### PR 2.3 — Role constraints

Scope:

- Add DB-level constraints/enums or CHECK constraints for platform and org roles.
- Normalize existing data before enforcement.

Validation:

- Migration diff reviewed live.
- Tests for invalid role rejection at app and DB layer.

## Phase 3 — CSRF and logout contract

Status: Not started
Risk: Medium/high
Related: ADR-013

Target PRs:

### PR 3.1 — CSRF foundation

Scope:

- Distinguish cookie-authenticated requests from Bearer/internal-auth requests in `authenticateRequest`.
- Add CSRF token issuance/validation for cookie-authenticated unsafe methods.
- Keep Bearer/API clients exempt from browser CSRF token requirements.

Validation:

- Route tests for cookie unsafe methods requiring CSRF.
- Route tests for Bearer unsafe methods not requiring browser CSRF.

### PR 3.2 — Logout compatibility

Scope:

- Add an Engram-compatible logout contract before enforcing CSRF on logout.
- Options from ADR-013:
  - top-level Engram logout redirect endpoint, or
  - CSRF-token acquisition endpoint, or
  - server-to-server logout credential/path for Nexus/Synapse.
- Update Nexus and Synapse logout flows if required.

Validation:

- Nexus logout smoke.
- Synapse logout smoke.
- Verify Engram cookies are actually cleared on parent domain.

## Phase 4 — JWT audience compatibility rollout

Status: Not started
Risk: High if not staged
Related: ADR-012

Target PRs:

### PR 4.1 — Engram emits audience claim

Scope:

- Add `aud: "ctxhost-suite"` to browser SSO access tokens.
- Do not require consumer validation yet.
- Preserve issuer `engram`, HS256, and shared secret.

Validation:

- Token tests assert audience is present.
- Existing consumers continue accepting tokens.

### PR 4.2 — Consumer compatibility validation

Scope:

Update each consumer verifier to accept expected audience while temporarily accepting missing audience:

- Nexus
- Synapse
- Thoughts
- Pulse
- Plexus

Validation:

- Per-repo JWT tests for:
  - expected audience accepted
  - missing audience accepted during compatibility window
  - wrong audience rejected when strict mode is enabled

### PR 4.3 — Engram/consumer strict audience enforcement

Scope:

- After all consumers deploy, require audience validation in consumers.
- Consider app-specific/native/API audiences separately from browser `ctxhost-suite` audience.

Validation:

- Suite login smoke across tenant apps.
- WebSocket auth smoke for Synapse.

## Phase 5 — JWT signing key migration planning

Status: Future
Risk: High
Related: ADR-014

Scope:

- Keep HS256 shared secret as the near-term contract.
- Design RS256/EdDSA + JWKS migration separately.
- Add `kid`/key overlap semantics before rotating keys.
- Update all consumers before switching token signing.

Deliverable:

- Follow-up implementation plan once ADR-014 is accepted and Phase 4 is complete.

## Suggested Thoughts project

Create a Thoughts project for this work. This is a good fit because the work crosses multiple repos and should be tracked as phased, reviewable slices rather than one large security branch.

Recommended project name:

- `Engram Auth Hardening`

Recommended columns/statuses:

- Backlog
- Ready
- In Progress
- In Review
- Blocked
- Done

Recommended initial tasks:

1. Phase 1.1 — Engram rate limiting and canonical URL guard.
2. Phase 1.2 — OAuth verified-email linking.
3. Phase 1.3 — Atomic refresh rotation and domain-aware logout clearing.
4. Phase 1.4 — Current-role DB checks, security headers, Docker non-root.
5. Phase 1.5 — Remove browser login `accessToken` JSON exposure after final consumer grep.
6. Phase 2.1 — Enforce user app entitlement target membership.
7. Phase 2.2 — Invalid user app entitlement cleanup report.
8. Phase 2.3 — Role constraints migration.
9. Phase 3.1 — CSRF foundation for cookie-authenticated unsafe methods.
10. Phase 3.2 — Logout compatibility for Nexus and Synapse.
11. Phase 4.1 — Engram emits suite audience claim.
12. Phase 4.2 — Consumer audience compatibility updates.
13. Phase 4.3 — Strict audience enforcement after deployment.
14. Phase 5 — JWKS/asymmetric signing implementation plan.

Suggested labels:

- `security`
- `engram`
- `auth-contract`
- `suite-impact`
- `consumer-update`
- `needs-adr`
- `migration`

Dependencies:

- Phase 1 can start immediately after docs PR lands.
- Phase 2 needs data cleanup/reporting before DB constraints.
- Phase 3 needs the logout contract decision accepted.
- Phase 4 needs ADR-012 accepted and consumers updated before strict enforcement.
- Phase 5 should wait until the HS256/audience contract is stable.
