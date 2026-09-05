# ADR-008: Human Users and Agent Service Principals

**Status:** Proposed
**Date:** 2026-04-25
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-005 (Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements), Synapse ADR-017 (Authentication Delegation to Engram), Synapse ADR-021 (Human vs Agent Identity Boundary), CORTEX ADR-074 (Hosted Agent Identity and Synapse Integration)

## Context

Engram is already the source of truth for suite human identity, organization membership, and app entitlements. Hosted Synapse admission now depends on an Engram-authenticated human user, current membership in the tenant organization, and an enabled `synapse` app entitlement.

The hosted suite also includes non-human actors:

- CORTEX fleet agents such as worker agents
- AWS-hosted workers behind the hosted CORTEX API
- dev-only smoke workers that verify dispatch and reply paths
- future client-network gateway agents and app-aware assistants
- internal product services calling each other on behalf of an authenticated request

These actors are not human users. Treating them as ordinary Engram `User` rows with browser sessions or human refresh tokens would blur audit trails, complicate revocation, and overfit machine credentials to the human login model. At the same time, leaving all machine identity local to Synapse or CORTEX forever would create split-brain organization and entitlement state once hosted clients receive their own assigned agents.

Engram therefore needs an explicit long-term identity boundary for humans versus agents/service principals.

## Decisions

### 1. Human users remain interactive Engram users

**Decision:** Human users authenticate through Engram's interactive human flows: password/OAuth/magic-link login, shared-domain browser cookies, native-client bearer tokens, refresh-token rotation, and account management.

A human tenant user's effective app admission requires:

1. valid Engram authentication
2. current membership in the target organization
3. the organization has the app entitlement enabled, for example `synapse`
4. any app-local authorization required by the consuming product

**Rationale:** Humans need one suite login surface and one source of truth for account state, org membership, and app rollout.

### 2. Agents and service accounts are first-class non-human principals

**Decision:** Engram's target architecture includes non-human principals for agents and service accounts. These principals are distinct from human `User` rows and must be modeled, audited, revoked, and displayed as machine identities.

A principal should carry at least:

- stable principal id
- owning organization, when tenant-scoped
- principal type, for example `AGENT` or `SERVICE_ACCOUNT`
- display name / identity slug, for example `forge`, `hosted-agent-1`, or `hosted-smoke`
- enabled app surfaces, initially including `synapse`
- allowed capabilities/scopes/domains
- status and credential metadata
- created/rotated/revoked timestamps

**Rationale:** Agents are not employees or client users. They need least-privilege machine identity, clear audit attribution, and independent credential lifecycle.

### 3. Agent credentials should use client-credentials semantics, not human refresh tokens

**Decision:** The long-term machine-auth flow is client-credentials style credential exchange or an equivalent non-interactive mechanism. Agents should not receive human browser cookies or human refresh tokens.

The preferred target flow is:

1. operator or provisioning flow creates an Engram agent/service principal
2. Engram issues a machine credential such as `client_id` + `client_secret`, a scoped API key, or a future private-key credential
3. the agent exchanges that credential for short-lived access tokens with an audience such as `synapse` or `cortex-api`, or presents a scoped key where a short-lived token service is not yet implemented
4. consuming services validate the credential/token, resolve the principal, and enforce app-local authorization

**Rationale:** Machine credentials need rotation and revocation, but not human refresh-token UX. Client-credentials semantics map cleanly to service principals and avoid pretending an agent completed an interactive login.

### 4. Engram owns org/app entitlement for principals; apps own resource authorization

**Decision:** Engram owns whether a human user or machine principal is associated with an organization and whether that organization/principal may use an app. Consumer apps still own app-local authorization.

Examples:

- Engram can say an agent principal belongs to the `cortex` org and may use `synapse`.
- Synapse decides whether that agent can subscribe to a room, post in a DM, or appear as a room member.
- CORTEX decides whether that principal can consume a domain stream or execute a capability.

**Rationale:** Centralizing high-level admission prevents cross-app drift, while local resource rules remain app-specific.

### 5. Existing app-local agent keys remain an explicit migration bridge

**Decision:** Existing Synapse/CORTEX agent keys may continue during migration. They are a compatibility bridge, not the final hosted identity model.

During the bridge period:

- app-local keys must be explicitly scoped by purpose and principal
- broad internal API keys must not be reused as agent websocket/reply credentials
- keys should be stored in CORTEX vault or runtime secret stores, not committed config
- docs must identify which key is for human auth, service-to-service dispatch, agent posting, or smoke verification

**Rationale:** The fleet already works with per-agent keys. A hard cutover to Engram service principals would block current hosted Synapse/CORTEX integration, but the target ownership must be clear now.

## Considered Options

### A. Human users plus first-class agent/service principals in Engram (CHOSEN)

Engram owns human identity and the target non-human principal registry. Apps consume those identities and keep resource authorization local.

**Chosen because:** It gives the suite one control-plane source of truth without conflating humans and machines.

### B. Model agents as ordinary human users

Create normal Engram users such as `forge@...` or `hosted-agent@...` and issue ordinary browser/native sessions.

**Rejected:** This pollutes human membership rosters, confuses audit trails, and gives machines credentials designed for people.

### C. Keep all agent identity permanently local to Synapse and CORTEX

Let each product maintain its own agent registry and keys forever.

**Rejected:** This is simple today but creates split-brain org/app entitlement state and makes hosted per-client agent provisioning hard to reason about.

### D. Require mTLS or private-key workload identity immediately

Make all agents use certificates or signed private-key assertions from day one.

**Deferred:** This may be the strongest future mechanism, but it is too much operational complexity for the first hosted Synapse/CORTEX slices.

## Migration Strategy

1. Keep human auth and org app entitlements as implemented by ADR-001 and ADR-005.
2. Document all current machine credentials and ensure broad API keys are not reused as agent reply/websocket tokens.
3. Add an Engram schema/API design for non-human principals and credential metadata.
4. Register hosted dev agents/smoke workers as principals before production use.
5. Migrate Synapse agent identity linking from `SYNAPSE_AGENT_KEY_*` only to Engram principal ids plus app-local projection rows.
6. Migrate CORTEX hosted worker identity to Engram-issued service-principal credentials or tokens.
7. Define revocation propagation: disabling an Engram principal or removing org/app entitlement must invalidate future Synapse/CORTEX access after the configured cache/reconciliation window.
8. Keep CORTEX vault/runtime secrets as the distribution mechanism for machine credentials.

## Consequences

### Positive

- clear human-vs-machine identity boundary
- Engram remains the suite control plane for org/app admission
- agents can be tenant-scoped without appearing as human members
- consuming apps retain local authorization where their resource models differ

### Negative

- requires new Engram schema/API work for service principals
- requires migration from existing env-var keys
- adds more credential lifecycle concepts for operators

### Risks

- **Over-broad service principals** — mitigated by explicit app/capability scopes and short-lived tokens where practical.
- **Partial migration drift** — mitigated by treating existing keys as a documented bridge and linking them to future principal ids.
- **Operator confusion** — mitigated by UI/API labels that distinguish human users, agents, and service accounts.
