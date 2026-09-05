# ADR-007: Nexus as the Tenant Workspace Consumer

**Status:** Accepted
**Date:** 2026-04-22
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-003 (Tenant Workspace Domains and Product Routing), ADR-005 (Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements), ADR-006 (Engram Hosts the Hosted-Suite Superadmin Console), cortex ADR-069 (Nexus as the Tenant Workspace Shell)

## Context

The hosted suite on `ctxhost.com` now has three distinct browser surfaces:

1. `login.*` for browser authentication and account entry
2. `platform.*` for hosted-suite superadmin functions
3. `<org>.*` for the tenant-root workspace experience

Earlier planning language treated Dashboard/Cortex as the org-facing workspace shell. That assumption has now been replaced by Nexus.

From Engram’s perspective, this creates an important product boundary question:
- what does Engram continue to own?
- what does Nexus consume from Engram?
- what should NOT move out of Engram into Nexus?

## Decision

### 1. Engram remains the identity and control plane

**Decision:** Engram remains the authoritative owner of:
- login/logout/session continuation
- account settings
- org selection / org switcher
- organizations / clients
- org memberships and roles
- invitations and admission flows
- app entitlements and feature entitlements
- hosted platform admin at `platform.*`

**Rationale:** These are identity and control-plane concerns. They belong with the service that already owns auth state, user/org records, and hosted policy.

### 2. Nexus becomes the tenant-root workspace consumer

**Decision:** Nexus is the org-facing workspace shell under `<org>.*` and consumes Engram identity/control-plane data rather than re-owning it.

Nexus should consume from Engram at minimum:
- current authenticated user identity
- org context for the current host
- user role within the current org
- app entitlements for the org
- lightweight org/member summary data needed for tenant-home UX

**Rationale:** Nexus is a consumer-facing shell, not a replacement identity provider. It should present tenant-root UX while relying on Engram as the source of truth.

### 3. Nexus should hand off identity/admin actions back to Engram

**Decision:** Nexus should initially deep-link or hand off to Engram for identity/control-plane actions instead of duplicating them.

Examples:
- switch organization
- manage account
- invite user
- membership/admin actions not yet implemented natively in Nexus
- platform-superadmin functions

**Rationale:** This keeps Nexus thin in v1 and avoids splitting identity/admin logic across products.

### 4. Product apps remain mounted under the tenant host

**Decision:** Nexus is the shell above product apps, not a replacement for them.

Hosted routing remains:
- `<org>.*` -> Nexus
- `<org>.*/synapse` -> Synapse
- `<org>.*/thoughts` -> Thoughts
- `<org>.*/pulse` -> Pulse

**Rationale:** This preserves the already accepted tenant-root + path-mounted app model while giving it a dedicated product shell.

## Consequences

### Positive

- Engram’s scope stays coherent: identity + hosted control plane
- Nexus can remain a thin workspace shell
- Tenant UX can evolve without moving auth/control-plane ownership out of Engram
- The split between `login.*`, `platform.*`, and `<org>.*` becomes clearer

### Negative

- Nexus depends on Engram APIs/data contracts for key tenant-home behaviors
- Some user/admin actions may initially feel like handoffs rather than fully native workspace actions
- Cross-repo coordination is required while Nexus is introduced

### Risks

- **Boundary drift** — mitigated by keeping Engram as the source of truth for identity, orgs, invites, and entitlements
- **Overbuilding Nexus into a second control plane** — mitigated by explicit handoff to Engram for identity/admin concerns
- **User confusion during transition** — mitigated by consistent docs and clear host responsibility (`login.*`, `platform.*`, `<org>.*`)

## Implementation direction

1. Keep Engram as the owner of identity, org, invite, and entitlement APIs.
2. Introduce Nexus as a new tenant-root workspace shell app.
3. Let Nexus consume Engram auth and org context through the existing browser SSO / continue-flow model.
4. Add richer Nexus-native UX only where it improves workspace experience without duplicating Engram control-plane responsibilities.
