# ADR-012: Suite JWT Audience Validation

**Status:** Proposed
**Date:** 2026-05-20
**Deciders:** Roland
**Related:** ADR-001 (Engram identity service), ADR-002 (Native Client Authentication), ADR-010 (Consumer App Admission Pattern), `docs/security-audit-2026-05-20.md`, `docs/suite-auth-consumer-audit-2026-05-20.md`

## Context

Engram issues access JWTs that suite applications validate locally. The current browser SSO contract is documented in ADR-010: consumers read `engram-access`, verify issuer `engram`, algorithm `HS256`, token `type: "access"`, and the shared `ENGRAM_JWT_SECRET`, then fetch `/api/orgs` for tenant/app admission.

The May 2026 security audit found that Engram and all audited consumers lack audience validation:

- Nexus verifies issuer `engram` and HS256 but no audience.
- Synapse verifies issuer `engram` and HS256 but no audience.
- Thoughts verifies issuer `engram` and HS256 but no audience.
- Pulse verifies issuer `engram` and HS256 but no audience.
- Plexus verifies issuer `engram` and HS256 but no audience.

This is acceptable only as a temporary compatibility state. Audience validation prevents cross-app token confusion and makes the intended recipient of a token explicit.

The suite also has a special constraint: the browser SSO cookie is shared across tenant hosts and app paths. A single browser access token may be used by Nexus and product apps during the same session. Strict app-specific audiences on the shared browser cookie would break SSO unless Engram minted app-specific tokens per app.

## Decisions

### D1. Browser SSO access tokens use a suite audience

**Decision:** Engram browser SSO access tokens will carry:

```text
aud: "ctxhost-suite"
```

This audience means the token is intended for browser-based hosted suite admission, not for a single app only.

### D2. Native/API tokens may use app-specific audiences later

**Decision:** App-specific audiences are reserved for native/API token exchange flows, not the shared browser SSO cookie in the first rollout.

Examples:

- `aud: "ctxhost-suite"` — browser SSO token.
- `aud: "synapse"` — possible future app-specific/native token.
- `aud: "thoughts"` — possible future app-specific/native token.

ADR-002 remains the home for native-client authentication details. This ADR only decides the suite browser SSO migration path.

### D3. Audience validation rolls out in compatibility phases

**Decision:** Audience validation must be staged.

1. Engram starts emitting `aud: "ctxhost-suite"` on browser access tokens.
2. Consumers update verifiers to accept `ctxhost-suite` while temporarily accepting tokens with missing `aud`.
3. After all consumers deploy, consumers reject missing or wrong audiences.
4. Later, app-specific/native audiences can be introduced for non-browser flows.

Engram must not require strict audience validation in consumers before the consumer fleet is updated.

### D4. Consumers keep local JWT validation and `/api/orgs` admission

**Decision:** Adding audience does not move org/app authorization into the JWT.

Tokens still do not carry org membership, app entitlements, or per-user overrides. Consumers must continue to fetch `/api/orgs` and apply ADR-010 admission rules so membership and entitlement revocations are not delayed until token expiry.

### D5. Issuer and algorithm remain stable during audience rollout

**Decision:** Audience rollout must not simultaneously change issuer, algorithm, or signing key distribution.

During this migration:

- `iss` remains `engram`.
- Signing remains HS256 with `ENGRAM_JWT_SECRET`.
- Consumers keep `algorithms: ["HS256"]`.

Signing-key migration is a separate decision covered by ADR-014.

## Considered Options

### Option A — Suite audience for browser SSO tokens (chosen)

Pros:

- Adds explicit audience semantics without breaking shared browser SSO.
- Allows one `engram-access` cookie to work across Nexus and product apps.
- Gives consumers a concrete claim to validate.
- Keeps app-specific audiences available for native/API flows later.

Cons:

- Does not distinguish one browser app from another at the JWT layer.
- Product apps still need `/api/orgs` for app-specific admission.

### Option B — App-specific audiences for every browser app

Pros:

- Strongest token recipient isolation.
- A Synapse token would not verify in Thoughts, and vice versa.

Cons:

- Conflicts with the current shared cookie SSO model.
- Would require token exchange or one cookie/token per app.
- High migration risk across every suite app.

Rejected for the browser SSO token. May be revisited for native/API flows.

### Option C — Keep no audience claim

Pros:

- No implementation work.
- No compatibility risk.

Cons:

- Leaves cross-app token confusion unaddressed.
- Keeps the token contract under-specified as the suite grows.

Rejected as a long-term state.

## Consequences

### Positive

- The token contract becomes more explicit.
- Consumers can fail closed on wrong-token-context bugs.
- The migration is compatible with current shared-cookie SSO.

### Negative

- Requires changes in every consumer before strict validation.
- Requires a compatibility window where missing audience is still accepted.

### Risks

- A consumer may enable strict audience validation before Engram emits `aud`, causing login failures.
- A consumer may validate only an app-specific audience and reject the suite browser token.

Mitigation: track rollout in the Engram Auth Hardening roadmap and gate strict enforcement until all consumers are deployed.

## Rollout

See `docs/roadmaps/2026-05-engram-auth-hardening.md` Phase 4.

## Links

- `docs/security-audit-2026-05-20.md`
- `docs/suite-auth-consumer-audit-2026-05-20.md`
- `docs/roadmaps/2026-05-engram-auth-hardening.md`
