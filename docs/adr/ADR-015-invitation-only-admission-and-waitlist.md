# ADR-015: Invitation-Only Admission and Waitlist Intake

**Status:** Proposed
**Date:** 2026-05-21
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-005 (Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements), ADR-006 (Engram Hosts the Hosted-Suite Superadmin Console), ADR-010 (Consumer App Admission Pattern), ADR-016 (Native PKCE Authorization Code Issuance for Entitled Invited Users)

## Context

Engram has already moved away from public self-service registration: `/api/auth/register` is disabled, `/register` is a waitlist surface, unknown OAuth users are directed to waitlist, and waitlist requests are stored without admitting users.

The phase-one hosted suite needs that policy to become a durable product contract rather than only an implementation detail. Users should not be able to create accounts merely because they reached Engram or started a Synapse native login. A user must first be created or invited for a specific organization, and that organization must have the target app entitlement before the user can enter a product app.

This matters especially for Synapse native auth. The native app can initiate Engram login and consume a PKCE auth code, but it must not become an admission surface. Invitation, membership, app entitlement, waitlist intake, and unknown-user handling remain Engram-owned control-plane concerns.

## Decisions

### 1. Phase-one admission is invitation-only

**Decision:** Phase-one hosted-suite users are admitted only after an Engram-controlled provisioning or invitation action creates an approved user and associates that user with a specific organization.

A public visitor cannot create a usable account by calling a registration API, completing OAuth, requesting a magic link, or starting a native authorization flow.

**Rationale:** The hosted rollout needs controlled onboarding. Separating waitlist interest from account admission prevents accidental tenant creation, unknown-user access, and app-local backdoors.

### 2. Waitlist requests are non-admitting

**Decision:** `/register` is a waitlist intake page and `/api/waitlist` records interest only. A waitlist request does not create a `User`, `OrgMember`, app entitlement, refresh token, native authorization code, or browser session.

Waitlist responses should stay generic and idempotent so the public surface does not reveal whether an email is already approved, already waitlisted, or unknown.

**Rationale:** Waitlist is a product intake channel, not an auth flow. Anti-enumeration behavior is more important than giving prospective users precise account-state feedback.

### 3. Unknown OAuth and magic-link users are not auto-provisioned

**Decision:** OAuth and magic-link flows may authenticate or link existing approved users, but they must not create new accounts for unknown emails.

Unknown OAuth users should be redirected to waitlist with safe context such as a prefilled email when the provider supplies one. Unknown magic-link requests should preserve generic success semantics without sending a sign-in link.

**Rationale:** OAuth and magic links are authentication methods for approved users, not admission methods for unknown users.

### 4. Invite links are admission/authentication entrypoints, not auth-code links

**Decision:** A user-facing invitation link may carry an opaque invitation token and may lead the user through Engram login, password setup, OAuth linking, or magic-link completion. It must not directly contain a native authorization code, access token, refresh token, or app-local session token.

The invitation token should be single-purpose admission state: identify the invited email/org/app context, enforce expiry and acceptance state, and then let normal Engram authentication issue sessions or native authorization codes.

**Rationale:** Authorization codes are OAuth artifacts issued after authentication and authorization. Embedding codes in invite links would blur admission, authentication, and token issuance boundaries.

### 5. App admission requires org membership and app entitlement

**Decision:** After authentication, normal tenant-user app access requires the user to be a current member of the target organization and the organization to have the target app enabled in Engram.

For Synapse this means membership in the tenant org plus an enabled `synapse` org app entitlement before normal browser or native app admission succeeds. Product apps still own resource-specific authorization after admission.

This preserves ADR-010's existing browser consumer-app `SUPERADMIN` bypass for platform debugging. ADR-016 separately narrows native authorization-code issuance so the broad browser consumer bypass does not automatically mint mobile app sessions for arbitrary tenant contexts.

**Rationale:** This keeps packaging and rollout centralized in Engram while preserving app-local authorization for rooms, projects, tasks, and other product resources.

### 6. Superadmin remains a control-plane exception, not tenant membership

**Decision:** Platform `SUPERADMIN` remains a control-plane role. It can provision users, create orgs, manage entitlements, and use the ADR-010 browser consumer-app bypass for platform debugging, but it should not be modeled as normal tenant membership merely to satisfy product admission checks.

**Rationale:** This preserves ADR-005 and ADR-006: platform operators manage the hosted suite without becoming visible client members in every tenant.

## Considered Options

### A. Keep waitlist-only registration and invitation-only admission (CHOSEN)

Disable public self-service account creation, keep waitlist non-admitting, and require admin/operator provisioning or invite acceptance before authentication can yield app access.

**Chosen because:** It matches the phase-one rollout posture, keeps unknown users outside the suite, and preserves Engram as the only admission control plane.

### B. Public self-service account creation with app access later

Allow anyone to create an Engram account, but gate app access on org membership and entitlements.

**Rejected:** This creates a population of authenticated-but-unadmitted accounts, increases abuse/enumeration risk, and complicates product messaging. Phase one intentionally avoids public accounts.

### C. Consumer-app-local invites

Let Synapse, Thoughts, or other apps own invite tokens and then create/link Engram users during first app launch.

**Rejected:** This would split identity admission across apps and create backdoors around Engram's central control plane. Consumer apps should request/consume Engram identity, not mint it.

### D. Invite links that directly contain native auth codes

Generate a native authorization code in the invite link so Synapse native can skip Engram login.

**Rejected:** Auth codes must be short-lived OAuth artifacts issued after authentication and authorization. Putting them in invite links would weaken the PKCE/authentication boundary and make invite forwarding equivalent to session transfer.

## Consequences

### Positive

- Unknown users have one safe path: waitlist.
- Engram remains the single admission authority for users, org membership, and app entitlements.
- Native clients cannot accidentally become account-creation surfaces.
- The model aligns browser and native admission around the same org/app entitlement checks.

### Negative

- Operators need first-class invite/provisioning workflows before broader onboarding.
- Users cannot immediately self-serve even if they know the tenant URL.
- Native full-auth smoke tests need either test credentials or an operator-only fixture rather than public signup.

### Risks

- **Hidden auto-provisioning paths** — mitigated by tests for registration, OAuth, magic link, and native authorize flows proving unknown users do not create accounts.
- **Invitation-token leakage** — mitigated by opaque hashed tokens, expiry, one-time acceptance, and no token/code material in invite URLs.
- **App-entitlement drift** — mitigated by reusing ADR-005/ADR-010 admission checks and keeping app entitlement management in Engram.

## Amendment Notes

- 2026-07-16: ADR-027 scopes this ADR's "no public self-service" posture to **suite clients**. Consumer clients (a `NativeAuthClient` with `autoJoinOrgSlug` set, e.g. `tradepost-web`) may flip `signupMode=open`, at which point self-serve registration and provider-verified OAuth signup create a user AND auto-join the client's designated registry org atomically. Decisions 1–3 above stand unchanged for every suite client and for any client left in `signupMode=waitlist`.

## Implementation notes

- Existing waitlist behavior is already partially implemented and should remain anti-enumeration-safe.
- Existing invite/provisioning state should be confirmed or extended so the durable contract includes hashed token, email, org, expiry, status, accepted timestamp, and inviter/operator metadata.
- Documentation and tests should keep saying "waitlist" rather than "register" for public prospective-user flows.
