# Engram integrations in the CORTEX suite

Purpose
- Document Engram’s current role in the multi-repo suite.
- Clarify the boundary between Engram as control plane and consumer apps as tenant workspaces.

What Engram owns
- human identity and authentication
- session continuation and refresh rotation
- user profiles
- organizations / clients
- org membership and org roles
- platform `SUPERADMIN`
- org app entitlements
- org feature entitlements
- global hosted-suite superadmin console
- first-party native client registration and Authorization Code + PKCE token issuance

What Engram does not own
- app-local authorization inside Dashboard, Synapse, Thoughts, Axon, or Pulse after admission
- tenant workspace UX under `<org>.ctxhost.com`
- shared hosted infrastructure ownership long-term; that remains documented as a Cortex concern via cortex ADR-068

Current suite integration points
- Dashboard validates Engram JWTs locally and uses Engram for browser SSO.
- Synapse validates Engram JWTs locally for human users while keeping local chat/agent authorization.
- Thoughts and Axon are included in the hosted app catalog and entitlement model even where full end-to-end admission enforcement is still in progress.
- Native apps such as Broca should register a native auth client and exact redirect URI in Engram, then use `/authorize` and `/api/auth/token` instead of adding app-specific auth routes.
- Native apps that have explicitly signed out should send `prompt=login` on the next `/authorize` request when they need to prevent silent browser-cookie session resume.
- Hosted suite routing is centered on:
  - auth: `login.ctxhost.com`
  - dev auth: `login.dev.ctxhost.com`
  - tenant roots: `<org>.ctxhost.com` and `<org>.dev.ctxhost.com`
  - app paths: `/synapse`, `/thoughts`, `/pulse`

Hosted control-plane boundary
- Engram is the platform control plane.
- Nexus is the tenant workspace shell.
- Dashboard is the internal operator console, not the tenant-root workspace.
- The Engram superadmin console is where hosted operators manage clients, users, apps, and feature flags across the entire suite.

Current gaps
- Consumer apps still need end-to-end host-derived org admission enforcement in some places.
- Nexus is now deployed on the shared AWS dev host at tenant roots like `cortex.dev.ctxhost.com`, but cross-app admission enforcement and broader tenant-shell rollout still need follow-through beyond the current dev runtime.
- Native client registration is data-backed, but a dedicated superadmin UI for managing native clients is still future work.
- Audit log and billing are intentionally outside the first superadmin-console slice.

Related docs
- `README.md`
- `docs/adr/ADR-001-engram-identity-service.md`
- `docs/adr/ADR-002-native-client-authentication.md`
- `docs/adr/ADR-005-suite-roles-org-roles-and-app-entitlements.md`
- `docs/adr/ADR-006-engram-superadmin-console.md`
- `docs/architecture-audit.md`
- `../../cortex/docs/adr/ADR-068-hosted-shared-platform-ownership.md`
- `../../cortex/docs/adr/ADR-069-nexus-tenant-workspace-shell.md`
- `docs/adr/ADR-007-nexus-tenant-shell-boundary.md`
