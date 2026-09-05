# ADR-006: Engram Hosts the Hosted-Suite Superadmin Console

**Status:** Accepted
**Date:** 2026-04-21
**Last Updated:** 2026-04-22
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-003 (Tenant Workspace Domains and Product Routing), ADR-005 (Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements), cortex ADR-068 (Hosted Shared Platform Ownership), cortex ADR-069 (Nexus as the Tenant Workspace Shell)

## Context

The hosted suite now has two distinct UX surfaces:

1. a tenant workspace surface for normal org users under `<org>.ctxhost.com`
2. a platform control-plane surface for hosted operators who need to manage all clients across the suite

Those platform operators need a first-class UI for:

- listing all hosted clients / organizations
- inspecting client memberships and org roles
- reviewing which apps are enabled for each client
- reviewing and changing feature flags per client
- seeing the global app catalog and feature registry

A natural temptation is to place this UI in Cortex/Dashboard because Dashboard already has a shell with a sidebar and header. But that would put global identity, client directory, and entitlement control into the tenant workspace repo rather than the identity/control-plane repo.

## Decisions

### 1. The global hosted admin console lives in Engram

**Decision:** The hosted-suite superadmin console is part of Engram.

It is not part of Cortex/Dashboard.

**Rationale:** Engram already owns the authoritative data and policy for:

- users
- organizations
- org memberships
- platform `SUPERADMIN`
- app catalog
- app entitlements
- feature entitlements
- auth/session state

The global admin console should live where those control-plane concepts are owned.

### 2. Nexus becomes the tenant workspace shell

**Decision:** Nexus is the org-facing workspace shell for normal end users after org admission is resolved.

Cortex/Dashboard remains the internal operator console and should not become the place where hosted tenant users land by default.

**Rationale:** This keeps the tenant workspace separate from both the platform control plane in Engram and the internal ops console in Cortex.

### 3. The Engram superadmin console should visually align with Dashboard

**Decision:** The Engram admin console should use a dashboard-like layout pattern:

- left sidebar
- top header
- content area with cards/tables/detail views

But it should remain implemented in Engram rather than being moved into Cortex only for visual reuse.

**Rationale:** UX consistency is desirable, but repo ownership should still follow the data/control boundary.

### 4. The first release scope is global read + org entitlement management

**Decision:** The initial superadmin console includes these sections:

- Overview
- Clients
- Client detail
- Users
- Apps
- Feature Flags

Initial behaviors:

- global client list across all orgs
- client detail showing members, roles, app entitlements, and feature entitlements
- global user directory with org memberships
- global app catalog view
- global feature registry view
- ability to enable/disable org app entitlements
- ability to enable/disable org feature entitlements

Not required in the first slice:

- billing
- audit log
- domains/custom domains
- delegated staff roles beyond `SUPERADMIN`
- app-local role editing inside consumer apps

**Rationale:** This is the minimum useful hosted control-plane UI.

### 5. UI labels may say “Clients” while the domain model stays “Organization”

**Decision:** The underlying data model remains `Organization`, but the global admin UI may present them as “Clients” where that is clearer.

**Rationale:** This keeps the model stable while allowing more business-friendly language in the superadmin surface.

### 6. Platform superadmin should not appear as an org member inside client detail views

**Decision:** The hosted admin console treats platform superadmin access as implicit control-plane authority, not as a visible org membership.

That means on `/admin/clients/[orgId]`:

- platform superadmins are not shown in the org member roster
- platform superadmins are not counted in client/member statistics shown by the admin console
- org member controls must not offer add/edit/remove operations for platform superadmins

**Rationale:** The client detail page is a tenant-management surface. Showing the platform operator there as a removable org member blurs the boundary between platform control and tenant membership.

### 2026-04-22 — Tenant workspace shell moved to Nexus

- Nexus replaces Dashboard as the planned tenant-root workspace shell under `<org>.*`.
- Dashboard is now positioned as the internal operator console.
- Engram remains the hosted control plane and `platform.*` admin owner.

## Information architecture

### Sidebar sections

- Overview
- Clients
- Users
- Apps
- Feature Flags

### Core routes

- `/admin`
- `/admin/clients`
- `/admin/clients/[orgId]`
- `/admin/users`
- `/admin/apps`
- `/admin/features`

### Access rule

Only platform `SUPERADMIN` can access `/admin/*`.

## Consequences

### Positive

- hosted control-plane ownership stays with Engram
- one place to inspect the full hosted client directory
- one place to manage app and feature rollout
- cleaner boundary between tenant UX and platform UX
- easier future extension to audit, billing, or hosted operations metadata

### Negative

- some dashboard-like shell patterns are duplicated across repos
- Engram now includes both auth UI and operator UI
- the Engram architecture audit and README must be updated so this new role is clear

### Risks

- **operator UI drift from policy APIs** — mitigated by keeping both in Engram
- **tenant/control-plane confusion** — mitigated by keeping Nexus org-facing, Dashboard internal/operator-facing, and Engram platform-facing
- **scope creep** — mitigated by keeping the first release focused on clients, users, apps, and feature flags only
