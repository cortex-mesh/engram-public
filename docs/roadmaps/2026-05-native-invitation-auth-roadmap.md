# Native Invitation Auth Roadmap — 2026-05

Status: Active
Owner: Engram
Related: [ADR-015](../adr/ADR-015-invitation-only-admission-and-waitlist.md), [ADR-016](../adr/ADR-016-native-pkce-auth-code-issuance.md), [ADR-002](../adr/ADR-002-native-client-authentication.md), [ADR-005](../adr/ADR-005-suite-roles-org-roles-and-app-entitlements.md), Synapse Native `docs/native-bootstrap-plan.md`

## Goal

Define the Engram-side admission and native auth-code contracts, then sequence the implementation work that unblocks Synapse Native's full callback/token-exchange/session-restore smoke while preserving phase-one invitation-only onboarding.

## Current state

- Engram already disables public self-service registration and exposes waitlist intake.
- Unknown OAuth users are directed toward waitlist rather than auto-provisioned.
- Engram already has database-backed native client registration, redirect URI registration, `/authorize`, `/api/auth/token`, hashed single-use authorization codes, and S256 PKCE validation.
- AWS-dev has the `synapse-native` client registered with the `synapse://auth/engram/callback` redirect URI.
- Synapse Native PR #1 verified tenant entry → Engram sign-in → Mobile Safari reaches the Engram login page without `invalid_client`.
- Synapse Native intentionally has not proven credentialed login, callback delivery, token exchange, session persistence after a real auth code, or authenticated relaunch restore.

## 2026-05-26 implementation checkpoint

- Native `/authorize` now requires explicit `tenant=<org-slug>&app=<app-key>` context before login continuation or code issuance.
- `synapse-native` is bound to `app=synapse` for phase one.
- Code issuance now requires authenticated non-internal user auth, tenant org membership, enabled org app entitlement, and no per-user app deny override.
- `POST /api/admin/native-auth-codes` is available only when `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE=1`, requires platform `SUPERADMIN`, reuses the normal hashed single-use authorization-code table/path, returns a callback URL only, and refuses to create users.
- Synapse Native now includes `tenant=<first tenant-host label>&app=synapse` in its Engram PKCE authorization URL.
- Local validation passed: Engram lint/typecheck/test/build; Synapse Native Swift test/build, app-wrapper validation, and iOS/macOS wrapper builds.
- Deployment workflow now requires Engram rollout to both hosted AWS dev and on-prem-host/on-prem after `main` CI passes; AWS dev can receive `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE` through `cortex-deploy.toml`, while on-prem-host reads the pre-existing host `.env`.
- Reviewed Engram `main` deploy workflow run `26463900522` passed both AWS-dev and on-prem-host/on-prem deploy jobs, including public endpoint verification, at commit `2a7a0f658734d37045c3ee7e2a0870308fcfb94c`.
- AWS-dev was redeployed by workflow run `26466504802` after enabling `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE=1`; unauthenticated fixture calls return `401`, proving the route is enabled and auth-gated.
- on-prem-host/on-prem health reports Engram `0.23.0`; unauthenticated fixture calls return `404`, proving the fixture remains disabled there by default.
- AWS-dev fixture smoke passed for existing admitted user `demo.member@ctxhost.local` without creating a new user: fixture issuance, normal PKCE token exchange, and hosted Synapse Bearer auth check all succeeded.

## Non-goals

- Do not re-enable public account creation.
- Do not put authorization codes, access tokens, or refresh tokens into invite links.
- Do not add a native credential collection screen to Synapse.
- Do not let Synapse Native create or admit users.
- Do not make the dev/test fixture available in production.

## Phase 0 — ADR and contract checkpoint

Status: In progress
Risk: Low

Deliverables:

- ADR-015: invitation-only admission and waitlist intake.
- ADR-016: native PKCE authorization-code issuance for entitled invited users.
- This roadmap.
- Synapse Native checkpoint already merged after Slice 19, marking native work paused pending this Engram track.

Validation:

- Docs review against ADR-001, ADR-002, ADR-005, and ADR-010.
- `git diff --check`.

## Phase 1 — Invitation/provisioning contract hardening

Status: Partially satisfied by existing pre-provisioned demo user/org/app admission; full invitation UX remains future work.
Risk: Medium

Target PRs:

### PR 1.1 — Explicit invite/admission model

Scope:

- Add or confirm an invitation/provisioning model that records:
  - invited email
  - target org
  - intended org role
  - optional app context such as `synapse`
  - hashed opaque invite token
  - expiry
  - accepted/revoked timestamps
  - operator/inviter metadata
- Keep waitlist requests separate from invitations.
- Add operator/admin mutation path for creating an invite or pre-approved user/org membership.
- Ensure accepting an invite creates or activates only the intended user/org membership.
- Pending invites are admission state only; native authorization codes require accepted/activated membership or pre-provisioned approved membership.

Validation:

- Tests for token hashing, expiry, one-time acceptance, revoked invite rejection, email mismatch, and no token material in logs.
- Tests that waitlist requests do not create users/memberships/tokens.
- `npm run typecheck`
- `npm run lint`

### PR 1.2 — Unknown-user auth path regression coverage

Scope:

- Add or refresh tests proving:
  - `/api/auth/register` creates no users/tokens and returns disabled/waitlist guidance.
  - unknown OAuth users redirect to waitlist and do not create users.
  - unknown magic-link requests keep generic success and send no sign-in token.
  - waitlist upsert remains idempotent and anti-enumeration-safe.

Validation:

- Targeted auth route tests.
- `npm run typecheck`
- `npm run lint`

## Phase 2 — Native authorize admission context

Status: Implemented, reviewed, merged, and deployed to AWS-dev and on-prem-host/on-prem on 2026-05-26.
Risk: Medium/high

Target PRs:

### PR 2.1 — Native `/authorize` tenant/app context

Scope:

- Decide and implement the phase-one wire shape for tenant/app context on native `/authorize`.
- Preferred simple shape for Synapse Native:
  - `tenant=<org-slug>`
  - `app=synapse`
- Validate tenant slug format and app key.
- Bind the chosen app to the native client where practical, so `synapse-native` cannot request unrelated apps.
- Update Synapse Native's PKCE URL builder in a coordinated PR if new query params are required.

Validation:

- Tests for missing tenant/app context failing closed.
- Tests for malformed tenant slug or unsupported app failing closed.
- Tests for `synapse-native` + `app=synapse` accepted only when client registration allows it.
- `npm run typecheck`
- `npm run lint`

### PR 2.2 — Native authorization code issuance gated by membership and app entitlement

Scope:

- Before issuing a native authorization code, verify:
  - authenticated Engram user is not internal/system auth
  - user is an approved/invited user
  - user is a member of the target org
  - target org has enabled app entitlement for the requested app
  - per-user app deny overrides are honored if ADR-009 is active on this path
- Return safe OAuth-style failures without leaking whether a user, org, or entitlement exists.
- Do not apply ADR-010's broad consumer-app `SUPERADMIN` bypass to native code issuance; operator/debug native smoke should use explicit test membership/entitlement or the operator-only fixture.

Validation:

- Tests for member + entitled org receiving a code.
- Tests for unknown user, no org membership, missing app entitlement, disabled native client, and redirect mismatch failing closed.
- Tests that failures do not create `NativeAuthAuthorizationCode` rows.
- `npm run typecheck`
- `npm run lint`

## Phase 3 — Operator-only auth-code fixture

Status: Implemented, reviewed, merged, and smoke-tested in AWS-dev on 2026-05-26; on-prem-host/on-prem keeps the fixture disabled by default.
Risk: Medium

Target PRs:

### PR 3.1 — Dev/test auth-code fixture issuer

Scope:

- Add an operator-only CLI or internal route that issues a real short-lived native authorization code for an approved user/org/app/client/redirect/PKCE tuple whose invitation has been accepted/activated or whose membership was operator pre-provisioned.
- Gate the fixture to non-production environments or explicit dev/test configuration.
- Reuse the same `NativeAuthAuthorizationCode` create path/table as normal `/authorize`.
- Fixture output should be limited to a callback URL or code/state metadata needed by the simulator smoke.
- Treat fixture callback URLs and auth codes as secret-bearing; deliver them only over the operator/test channel and redact them from logs, PRs, screenshots, and public docs.
- Never emit access tokens or refresh tokens.

Validation:

- Tests for production-disabled behavior.
- Tests for operator authorization required.
- Tests for missing membership/app entitlement/native client registration failing closed.
- Tests that fixture-issued codes can be consumed only through normal `/api/auth/token` with the correct verifier.
- Redaction tests for code/verifier/token-like material in errors/debug output.
- `npm run typecheck`
- `npm run lint`

### PR 3.2 — Deployment and fixture smoke runbook

Scope:

- Document the safe operator steps to deploy Engram to AWS dev and on-prem-host/on-prem before native fixture smoke.
- Document the safe operator steps to issue a fixture code for an approved Synapse test user in the target environment.
- Include non-secret inputs needed by Synapse Native:
  - org slug
  - client id
  - redirect URI
  - app key
  - generated PKCE challenge/state flow
- Include explicit redaction instructions for callback URLs/codes in summaries.

Validation:

- Confirm `main` CI passes before deploy.
- Confirm the deploy workflow or equivalent operator commands roll out to both AWS dev and on-prem-host/on-prem.
- Dry-run fixture against test/dev databases where possible.
- No secrets committed to docs or fixtures.

2026-05-26 evidence:

- Deploy run `26463900522` passed AWS-dev and on-prem-host/on-prem deploy jobs from reviewed `main`.
- Deploy run `26466504802` passed AWS-dev redeploy after enabling the dev/test fixture.
- AWS-dev smoke used existing `demo.member@ctxhost.local` in org `demo` with `synapse-native` and `synapse://auth/engram/callback`.
- The smoke exchanged the fixture code through the normal token endpoint and authenticated against hosted Synapse as the expected human user.
- No auth codes, callback URLs, verifiers, access tokens, refresh tokens, or signing secrets were committed or recorded in docs.

## Phase 4 — Synapse Native full auth smoke

Status: Unblocked for fixture-driven native-app implementation after the 2026-05-26 Engram deployment and AWS-dev fixture/token/Synapse auth smoke.
Risk: Medium

Target PRs / coordinated work:

### PR 4.1 — Synapse Native auth URL alignment

Scope:

- If Phase 2 adds tenant/app query params, update Synapse Native's authorization URL builder and tests.
- Preserve fail-closed callback state handling.
- Keep tests deterministic with recording transports.

Validation:

- Swift tests for new URL query contract.
- Existing UI smoke still reaches Engram login page.

### PR 4.2 — Fixture-driven callback/token/session smoke

Scope:

- Generate a PKCE verifier/challenge/state.
- Use the Engram fixture to issue a real authorization code for an approved test user and entitled org.
- Deliver the callback URL to the iOS simulator.
- Verify native token exchange, session creation, Keychain persistence, relaunch restore, and initial live snapshot loading.

Validation:

- No credentials/tokens in repo, logs, screenshots, or summaries.
- Simulator smoke evidence redacts callback/code/token material.
- Synapse Native `swift test`, app-wrapper validation, iOS build, and smoke pass.

## Phase 5 — Real invited-user browser smoke

Status: Blocked on invitation UX and a real test user
Risk: Medium/high

Scope:

- Create or invite a real AWS-dev test user for a specific org with `synapse` entitlement.
- Use a real invite link and Engram login flow.
- Confirm native callback and session restore through the normal user path, not the fixture.

Validation:

- Manual or semi-manual QA evidence with secrets redacted.
- Confirm unknown user still lands on waitlist and cannot self-create.

## Production/TestFlight blockers after this roadmap

- Universal links / claimed HTTPS callback decision and implementation if required before TestFlight.
- Native logout and refresh-token revocation UX.
- APNs permission prompt, device-token acquisition, provider delivery, invalid-token feedback, and secret wiring.
- Physical-device/TestFlight smoke for login, restore, replay, badge refresh, notification tap, and send retry.
