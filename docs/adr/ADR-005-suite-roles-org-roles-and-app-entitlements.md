# ADR-005: Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements

**Status:** Accepted
**Date:** 2026-04-20
**Updated:** 2026-04-25
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-003 (Tenant Workspace Domains and Product Routing), ADR-004 (Initial AWS Infrastructure with CDK), ADR-008 (Human Users and Agent Service Principals)

## Context

Engram is the centralized identity layer for the hosted platform, but the original role and entitlement model was too vague for the intended suite shape.

The hosted model now needs to support all of the following cleanly:

- a narrow platform control plane operated by a very small number of people
- organization-level ownership and administration
- explicit app enablement per organization
- explicit feature enablement per organization within an app
- org-scoped product access under tenant hosts such as `<org>.ctxhost.com/<app>`
- future hosted suite rollout where not every org automatically receives every app or feature

The initial schema and code treated roles as open-ended strings and did not yet define a durable contract for app and feature admission. That is no longer sufficient.

## Decisions

### 1. Platform authority stays minimal

**Decision:** Engram uses a narrow platform-level `SUPERADMIN` role for control-plane actions.

Normal authenticated users do not receive platform provisioning authority by default. A broader platform-wide `ADMIN` role may still exist as a user label, but it is not part of the hosted provisioning contract and does not grant organization creation or entitlement management rights.

**Rationale:** The hosted platform control plane should stay small. The only clearly required platform authority today is the ability to create orgs, review the global client directory, and manage app/feature rollout.

### 2. Only `SUPERADMIN` can create orgs and manage org entitlements

**Decision:** Platform `SUPERADMIN` is the only role that can:

- create organizations
- view the full cross-org client directory
- grant or revoke app entitlements for an org
- grant or revoke feature entitlements for an org
- access the global hosted-suite administration console

**Rationale:** These are platform control-plane actions, not org-local actions.

### 2a. Platform `SUPERADMIN` access to orgs is implicit, not membership-based

**Decision:** Platform `SUPERADMIN` access to organization administration is implicit and does not depend on maintaining an `OrgMember` row inside each organization.

Consequences of that rule:

- platform superadmins always retain control-plane access to any org in the hosted suite
- the hosted admin console must not require an explicit org membership just to let a `SUPERADMIN` inspect or manage an org
- explicit `OrgMember` rows for platform superadmins are not part of the intended long-term model and should not be created through normal org member management flows
- if legacy explicit memberships exist for a platform superadmin, they are treated as implementation residue rather than user-visible org memberships

**Rationale:** Platform authority is a control-plane concern. Requiring per-org membership for a platform superadmin creates unnecessary bookkeeping, confusing UI, and hidden policy coupling between platform access and org-local membership state.

### 2b. Platform `SUPERADMIN` is not counted as an org member for hosted admin UX/stats

**Decision:** In hosted control-plane views, platform superadmins do not count toward org member statistics and should not appear in the visible org member roster.

That means the superadmin console should:

- hide platform superadmins from org member tables
- exclude platform superadmins from org/client member counts shown in admin stats
- treat the superadmin's org access as implicit control-plane authority instead of a normal client membership

**Rationale:** The platform operator is not the client. Counting or displaying the platform operator as a client member makes org statistics misleading and encourages accidental mutation of a control-plane identity through org-local controls.

### 2c. Org member management cannot edit or remove platform `SUPERADMIN`

**Decision:** Org membership management flows must not allow operators to add, demote, or remove a platform superadmin as though they were a normal org member.

**Rationale:** A platform superadmin should not be removable from effective org access by org-local controls, nor should the org UI imply that its membership row is the source of truth for platform authority.

### 3. Organization roles are `OWNER`, `ADMIN`, and `MEMBER`

**Decision:** `OrgMember.role` uses the following values:

| Org role | Meaning | Can manage org-local settings? | Can manage members? |
| --- | --- | --- | --- |
| `OWNER` | Highest authority inside the org | Yes | Yes |
| `ADMIN` | Org administrator | Yes | Yes, with policy limits |
| `MEMBER` | Standard participant | No | No |

At organization creation time, the provisioning flow must assign at least one initial `OWNER`.

**Rationale:** `OWNER` / `ADMIN` / `MEMBER` is a familiar and durable model for a hosted multi-tenant suite.

### 4. App access is an explicit org entitlement

**Decision:** App access is stored explicitly per org rather than implied from org membership alone.

Current app catalog keys are:

- `dashboard`
- `synapse`
- `thoughts`
- `axon`
- `pulse`

The persistence contract is an org-scoped entitlement table keyed by `(orgId, appKey)`.

**Rationale:** This keeps product packaging and rollout centralized. Membership alone should not imply access to every current and future product.

### 5. Feature access is an explicit org entitlement within an app

**Decision:** Feature flags are also stored explicitly per org and app.

Current feature registry is intentionally small and namespaced by app. The initial live set is:

- `thoughts.projects`
- `thoughts.adr`

The persistence contract is an org-scoped feature entitlement table keyed by `(orgId, appKey, featureKey)`.

**Rationale:** Feature rollout is also a platform concern and should not be hidden inside ad hoc product-specific conditionals.

### 6. Effective app admission requires identity, org membership, and org entitlement for tenant users

**Decision:** A normal tenant user can access an app under `<org>.ctxhost.com/<app>` only when all of the following are true:

1. the user is authenticated by Engram
2. the user is a current member of the target org
3. the org has the app enabled in Engram

Platform `SUPERADMIN` is a control-plane exception and retains implicit administrative access to org management flows even without a normal `OrgMember` row.

**Rationale:** This separates tenant admission from platform control-plane authority and prevents accidental cross-product access for normal users.

### 7. Effective feature admission requires identity, org membership, app entitlement, and feature entitlement for tenant users

**Decision:** A normal tenant user can access a feature inside an app only when all of the following are true:

1. the user is authenticated by Engram
2. the user is a current member of the target org
3. the org has the app enabled
4. the org has the feature enabled for that app

Platform `SUPERADMIN` remains a control-plane exception for hosted administrative surfaces and should not be modeled as a normal tenant member merely to satisfy app/feature admission checks.

**Rationale:** This creates one consistent rollout contract for tenant users while keeping platform operator authority conceptually separate.

### 8. App-internal authorization remains app-local for now

**Decision:** Engram owns identity, org membership, org app admission, and org feature admission. Consumer apps still own app-local authorization after admission.

Examples:

- Synapse can keep chat-specific moderation or room authorization local
- Thoughts can keep task/project workflow permissions local
- Dashboard can keep workspace-specific UI policy local

**Rationale:** Product-local permission models differ and should not be centralized prematurely.

### 9. Machine principals are separate from human org members

**Decision:** ADR-008 extends the entitlement model to non-human principals. Agent/service principals may be associated with an org and app capabilities, but they are not normal human `OrgMember` records and should not appear in client human member rosters.

**Rationale:** Agents need org/app admission and auditability without being treated as people for membership UX, role management, or human session lifecycle.

## Current implementation status

The following are already implemented in Engram:

- platform `SUPERADMIN`
- org roles `OWNER` / `ADMIN` / `MEMBER`
- org app entitlements
- org feature entitlements
- app catalog entries for `dashboard`, `synapse`, `thoughts`, `axon`, `pulse`
- feature registry entries for `thoughts.projects` and `thoughts.adr`
- API routes for listing and mutating org entitlements

The next hosted control-plane step is a first-class superadmin console in Engram for global client, user, app, and feature management.

## Authorization matrix

### Platform-level actions

| Action | Authenticated user | SUPERADMIN |
| --- | --- | --- |
| Sign in | Yes | Yes |
| View own account | Yes | Yes |
| Create organization | No | Yes |
| View all clients | No | Yes |
| Grant app entitlement to org | No | Yes |
| Revoke app entitlement from org | No | Yes |
| Grant feature entitlement to org | No | Yes |
| Revoke feature entitlement from org | No | Yes |
| Access hosted admin console | No | Yes |

### Org-level actions

| Action | MEMBER | ADMIN | OWNER |
| --- | --- | --- | --- |
| Enter org workspace | Yes | Yes | Yes |
| Access entitled apps | Yes | Yes | Yes |
| Invite/remove users | No | Yes, with policy limits | Yes |
| Manage org-local settings | No | Yes | Yes |
| Manage admin roles | No | No | Yes |

## Consequences

### Positive

- clear separation between platform control and org-local authority
- explicit packaging and rollout contract for hosted apps and feature flags
- consumer apps get a single admission boundary to integrate against
- Engram becomes the durable source of truth for hosted-suite identity and entitlement policy

### Negative

- more control-plane data to surface and manage
- consumer apps still need to implement admission checks consistently
- the hosted control plane now deserves its own admin UX, not just raw APIs

### Risks

- **partial rollout drift** — mitigated by making Engram the single source of truth
- **overusing `SUPERADMIN`** — mitigated by keeping it rare
- **doc/code drift** — mitigated by updating ADRs, runbooks, and the architecture audit alongside implementation
