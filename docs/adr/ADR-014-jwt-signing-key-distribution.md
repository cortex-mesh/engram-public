# ADR-014: JWT Signing Key Distribution and Future JWKS Migration

**Status:** Proposed
**Date:** 2026-05-20
**Deciders:** Roland
**Related:** ADR-001 (Engram identity service), ADR-002 (Native Client Authentication), ADR-010 (Consumer App Admission Pattern), ADR-012 (Suite JWT Audience Validation), `docs/security-audit-2026-05-20.md`, `docs/suite-auth-consumer-audit-2026-05-20.md`

## Context

Engram currently signs access and refresh JWTs with HS256 using `ENGRAM_JWT_SECRET`. Consumer apps validate access tokens locally with the same shared secret.

This gives excellent runtime performance and no network dependency during request admission, but it has drawbacks:

- Every consumer that can verify tokens also has material capable of minting tokens if compromised.
- Secret rotation must be coordinated across Engram and every consumer.
- There is no `kid`/key overlap story for seamless rotation.
- The suite cannot safely expose verification material broadly because the symmetric secret is also signing material.

The May 2026 consumer audit confirmed that Nexus, Synapse, Thoughts, Pulse, and Plexus all depend on this HS256 shared-secret contract today. Changing it immediately would break the suite.

## Decisions

### D1. HS256 shared secret remains the near-term contract

**Decision:** Engram will keep HS256 with `ENGRAM_JWT_SECRET` as the near-term signing contract while the suite completes auth hardening and audience rollout.

Routine hardening PRs must not switch algorithms or signing keys.

### D2. Consumers must continue pinning algorithm while HS256 remains active

**Decision:** Consumers must pin `algorithms: ["HS256"]` while validating HS256 tokens.

Algorithm pinning is a current hardening requirement and remains valid before and after audience rollout.

### D3. Asymmetric signing with JWKS is the preferred future direction

**Decision:** The intended long-term direction is asymmetric signing:

- Engram signs access tokens with a private key.
- Consumers verify with public keys from JWKS or pinned public-key configuration.
- Consumers cannot mint tokens.
- Key IDs (`kid`) support overlapping rotation windows.

The exact algorithm (for example RS256 or EdDSA) is deferred to the implementation ADR/plan for the migration.

### D4. JWKS migration requires a separate compatibility rollout

**Decision:** Engram must not switch to asymmetric signing until every consumer supports the new verification path.

Minimum rollout:

1. Add consumer verifier abstraction that can support HS256 and future JWKS.
2. Publish Engram JWKS endpoint or public-key configuration while HS256 remains active.
3. Add `kid` to newly signed tokens.
4. Update consumers to prefer JWKS/asymmetric validation when token headers indicate the new key type, while still accepting HS256 during migration.
5. Switch Engram access-token signing to asymmetric keys after consumers deploy.
6. Retire HS256 access-token verification after a bounded compatibility window.

Refresh tokens may remain Engram-internal and do not need to be accepted by consumers.

### D5. Audience rollout comes before signing migration

**Decision:** ADR-012 audience rollout should complete before JWKS migration starts.

Rationale: audience validation fixes token recipient semantics while preserving the current signing model. It is a smaller migration and gives the suite a better contract before changing key distribution.

## Considered Options

### Option A — Keep HS256 now, plan JWKS migration later (chosen)

Pros:

- Avoids breaking current consumers.
- Lets Engram fix immediate security issues first.
- Documents the desired end state without rushing a high-risk migration.

Cons:

- Shared signing material remains in consumers during the interim.
- Secret rotation remains operationally coordinated.

### Option B — Switch immediately to RS256/JWKS

Pros:

- Removes signing authority from consumers quickly.
- Enables public verification material and safer key distribution.

Cons:

- Breaks every audited consumer until updated.
- Bundles key migration with unrelated hardening work.
- Increases risk of suite-wide login outage.

Rejected for immediate implementation.

### Option C — Stay on HS256 permanently

Pros:

- Simple and already implemented.
- No consumer migration.

Cons:

- Consumers retain signing-capable material.
- Rotation remains brittle.
- Does not scale well as the suite grows.

Rejected as the long-term target.

## Consequences

### Positive

- Near-term fixes can proceed without destabilizing auth.
- The long-term direction is explicit.
- Consumers can prepare verifier abstractions before Engram changes signing.

### Negative

- HS256 shared-secret risk remains until a future migration completes.
- Requires another suite-wide project after audience rollout.

### Risks

- A future implementation may try to combine JWKS migration with other auth changes.
- Consumers may drift if verifier abstraction is not tracked across repos.

Mitigation: track JWKS work as a separate phase in the Engram Auth Hardening roadmap and do not begin until Phase 4 audience work is complete.

## Rollout

See `docs/roadmaps/2026-05-engram-auth-hardening.md` Phase 5.

## Links

- `docs/security-audit-2026-05-20.md`
- `docs/suite-auth-consumer-audit-2026-05-20.md`
- `docs/roadmaps/2026-05-engram-auth-hardening.md`
