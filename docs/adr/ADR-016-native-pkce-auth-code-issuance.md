# ADR-016: Native PKCE Authorization Code Issuance for Entitled Invited Users

**Status:** Proposed
**Date:** 2026-05-21
**Last Updated:** 2026-05-26
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-002 (Native Client Authentication), ADR-005 (Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements), ADR-010 (Consumer App Admission Pattern), ADR-015 (Invitation-Only Admission and Waitlist Intake)

## Amendment Notes

- **2026-05-26:** Synapse Native moved to identity-first login. Engram may issue a native authorization code for `app=synapse` without a preselected `tenant`; token exchange then returns only the Synapse tenant hosts the authenticated user is approved for. Tenant-scoped `/authorize?tenant=<org-slug>&app=synapse` remains valid for fixture/debug and direct-context flows.

## Context

ADR-002 defines Engram native authentication as Authorization Code + PKCE with registered first-party clients, redirect URI validation, short-lived single-use auth codes, and Engram-owned token exchange.

Synapse native has now reached the next auth boundary. The native app can generate PKCE authorization URLs, open Engram in Safari, parse callbacks, exchange codes through an injected token-exchange seam, persist sessions in Keychain, and restore on launch. A no-credentials simulator smoke proves the registered `synapse-native` client reaches Engram's login page instead of failing with `invalid_client`.

The remaining gap is not native URL construction. The remaining gap is Engram-side admission and a safe deterministic way to complete full callback/token-exchange/session-restore smoke without storing real credentials in the native repo or allowing unknown users to self-provision.

## Decisions

### 1. Native authorization code issuance is org/app-entitlement aware

**Decision:** Engram may issue a native authorization code only after all of the following are true:

1. the native `client_id` is registered and enabled
2. the exact `redirect_uri` is registered and enabled for that client
3. the request uses `response_type=code` and S256 PKCE
4. the user is authenticated by Engram
5. the user is an approved user whose invitation has been accepted/activated or whose account was pre-provisioned by an operator, not a pending-invite or waitlist-only unknown
6. the user is a current member of the target organization
7. the target organization has the target app enabled, such as `synapse`
8. the requested/native client is allowed to represent that target app

For identity-first native flows that omit `tenant`, items 6 and 7 are enforced when resolving the tenant list returned by token exchange rather than before code issuance. The app receives an Engram identity token plus only the tenant hosts that satisfy membership, org app entitlement, per-user deny, and native client/app binding checks.

**Rationale:** A native auth code is the handoff from identity provider to app. Tenant-scoped code issuance must not bypass the suite's normal hosted admission boundary. Identity-first mobile login still preserves that boundary by withholding tenant hosts until Engram has confirmed app entitlement for the authenticated user.

### 1a. Native code issuance does not inherit the broad consumer-app SUPERADMIN bypass

**Decision:** ADR-010's consumer-app `SUPERADMIN` bypass does not automatically grant native authorization codes for arbitrary tenant/app contexts. Native code issuance is a user-session handoff into a specific app and tenant; phase-one operator/debug smoke should use explicit test membership/entitlement or the operator-only fixture path rather than relying on invisible tenant membership.

A future ADR may define a distinct native operator/debug flow, but it must be explicit and auditable rather than an accidental extension of browser consumer admission.

**Rationale:** Platform `SUPERADMIN` is control-plane authority, not normal tenant membership. Keeping the native path explicit avoids a broad mobile session bypass while preserving browser/admin debugging through the existing control-plane surfaces.

### 2. Native authorization must carry enough tenant/app context to check admission

**Decision:** The native `/authorize` contract needs an explicit, validated way to determine the target tenant organization and app. The concrete wire shape may be finalized during implementation, but it must be unambiguous and fail closed.

Acceptable phase-one shapes include one of:

- `app=synapse` on `/authorize`, followed by tenant host selection from the token response's Engram-approved tenant list
- `tenant=<org-slug>&app=synapse` query parameters on `/authorize`
- a registered native client that is bound to one app plus a tenant slug inferred from a first-party hosted entrypoint
- an invite/session continuation record that already carries org/app context

The implementation must not infer tenant from arbitrary native app local state, untrusted callback parameters, or a naked user-selected string that is not confirmed against Engram membership. When the native app starts tenantless, it must only offer tenant hosts returned by Engram for the authenticated user and app.

If query parameters are used, they are Engram native-authorization context only. They do not change ADR-010's rule that consumer product-app routes derive tenant boundaries from the hosted `Host` header rather than arbitrary query strings.

**Rationale:** Native apps do not naturally have a tenant host boundary like `<org>.ctxhost.com/synapse`. Engram must still perform the same org/app admission check before granting tenant-specific app access, either before code issuance for tenant-scoped flows or while producing the post-login tenant list for identity-first flows.

### 3. Invite links remain separate from native auth codes

**Decision:** User-facing invite links do not contain auth codes. An invite link may lead to Engram authentication and activate membership; after that, the normal `/authorize` flow may issue a native authorization code.

**Rationale:** Invitation is admission state. Authorization codes are short-lived OAuth artifacts issued after authentication and authorization. Keeping them separate preserves PKCE semantics and reduces risk if an invite link is forwarded or leaked.

### 4. Dev/test auth-code fixture is allowed only as an operator-only code issuer

**Decision:** Engram may provide a dev/test-only operator fixture that issues a real native authorization code for an already-approved user/org/app/native-client/PKCE tuple. The fixture must not mint access or refresh tokens directly.

Minimum fixture requirements:

- unavailable or inert in production
- requires operator/admin authorization or a non-public operator channel
- accepts or generates a PKCE challenge/state for the native test
- validates the user exists and is approved through an accepted/activated invitation or operator pre-provisioning; pending invites are insufficient
- validates org membership
- validates the org app entitlement, e.g. `synapse`
- validates registered `client_id` and exact `redirect_uri`
- stores the code through the same hashed single-use authorization-code table/path as browser login
- emits only a callback URL or code/state metadata needed by the simulator smoke
- never logs or returns access tokens, refresh tokens, or id tokens
- uses a short TTL and single-use consume semantics

Fixture callback URLs and authorization codes are still secret-bearing, even when short-lived. They must be delivered only over the operator/test channel and redacted from logs, PRs, screenshots, and public docs.

**Rationale:** This unblocks deterministic native callback/token-exchange/session-restore smoke without storing credentials, automating a browser password flow, or adding test-only behavior to Synapse native.

### 5. Token exchange remains the only way to mint native tokens

**Decision:** Even for fixtures, native access/refresh tokens are minted only by `POST /api/auth/token` after Engram consumes the auth code and validates the PKCE verifier.

**Rationale:** The fixture should skip only the human credential entry step. It should still exercise the real native callback, token endpoint, code consumption, token issuance, native session creation, and Keychain restore path.

### 6. Native token material stays out of logs and public docs

**Decision:** Authorization codes, code verifiers, access tokens, refresh tokens, and id tokens must not appear in logs, test summaries, screenshots, PR bodies, or public docs. Test fixtures should redact or omit token material by default.

**Rationale:** Native auth smoke is security-sensitive even in dev. Keeping redaction explicit prevents safe test tooling from becoming a token disclosure channel.

## Considered Options

### A. Org/app-entitled native PKCE with operator-only auth-code fixture (CHOSEN)

Require normal native PKCE, add org/app admission before code issuance, and provide a dev/test fixture that creates real short-lived codes only for approved users.

**Chosen because:** It preserves the identity/admission boundary while giving Synapse native a deterministic full-auth smoke path.

### B. Use real test credentials only

Create a test user and automate login in Safari or ask an operator to manually complete login for every smoke.

**Rejected as the only strategy:** Real credentials are useful for final manual QA, but they are brittle for repeatable simulator smoke and should not be stored in native repo configuration.

### C. Fixture mints tokens directly

Expose an operator endpoint that returns access/refresh tokens for a test user.

**Rejected:** This bypasses the exact token-exchange path the native app needs to prove. It would make smoke success less meaningful and create a more dangerous secret-returning operator surface.

### D. Let Synapse native create users for local testing

Add a native test-only path that creates a user or bypasses Engram admission in dev.

**Rejected:** This violates ADR-015 and makes the native app an admission surface. Tests should exercise Engram contracts, not bypass them.

### E. Put auth codes in invite links

Generate auth codes as part of invite URLs so the native app can launch directly into callback handling.

**Rejected:** Invite links are longer-lived and user-forwardable; auth codes must be short-lived, single-use, and issued after authentication and authorization.

## Consequences

### Positive

- Native auth uses the same invitation, org membership, and app entitlement policy as browser app admission.
- Synapse native can run a full callback/token-exchange/session-restore smoke without credentials in the repo.
- The fixture validates the real token endpoint rather than bypassing it.
- Unknown users remain waitlist-only even when they begin a native auth flow.

### Negative

- `/authorize` needs tenant/app context and admission checks beyond the current native client/redirect validation.
- Engram needs operator-only fixture plumbing and tests.
- Native smoke becomes cross-repo: Engram must provide a code, Synapse native consumes it.

### Risks

- **Fixture exposure in production** — mitigated by env gating, operator auth, and no-op behavior in production.
- **Tenant confusion in native authorize** — mitigated by explicit org/app context and Engram-side membership/entitlement verification.
- **Token leakage in smoke output** — mitigated by redaction tests and fixture output limited to callback/code metadata.
- **Auth-code replay** — mitigated by existing hashed single-use code consumption and short TTL.

## Implementation notes

- Current Engram code already has `NativeAuthClient`, `NativeAuthRedirectUri`, and `NativeAuthAuthorizationCode` models plus `/authorize` and `/api/auth/token` routes. This ADR narrows what must happen before code issuance.
- Synapse native currently uses `client_id=synapse-native` and `redirect_uri=synapse://auth/engram/callback` in AWS-dev.
- A first fixture implementation should live behind an operator-only CLI or internal route. Prefer a CLI or non-public admin endpoint over a public unauthenticated route.
- The fixture should be documented as dev/test smoke tooling, not as a user-facing recovery or invite mechanism.
