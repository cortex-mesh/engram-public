# ADR-024: Post-Login Routing to Most-Recently-Used Org's Nexus

- **Date:** 2026-06-16
- **Status:** Accepted

## Context

Before this ADR, multi-org users landed on `/account` after login and then had to **manually navigate** to their Nexus tenant workspace. Single-org users were already routed straight to their tenant (PR #80); multi-org users were not.

Two forces motivate routing users away from `/account`:

- Engram's `/account` page is **fragile under the Next standalone `cookies()` bug** ([ADR-023](ADR-023-next-standalone-cookies-fix.md)) — it is the most affected server-component surface. Routing users straight to their Nexus reduces exposure (Nexus and all tenant-host surfaces are **confirmed unaffected** by the standalone `cookies()` issue).
- A returning user almost always wants their workspace, not the settings page.

The app-switcher endpoint (`GET /api/me/app-switcher`) already derives the **active org from the request `Origin` header** under host-based tenancy (`<slug>.dev.ctxhost.com`), and it runs on every Nexus page load — giving us a natural place to record which org a user is actively in.

## Decision

### 1. Track the most-recently-used org

Add `lastOrgId` to the `User` model: a nullable FK to `Organization`, `onDelete: SetNull`. Update it **best-effort** inside `GET /api/me/app-switcher` when the active org is **host-derived AND a current membership** — i.e. *not* the off-tenant `memberOrgs[0]` fallback and *not* a `?org=` override — and only when the value actually changed. Because the app-switcher runs on every Nexus page load, org switches (a full navigation to the new tenant host) are captured automatically. A transient DB error on this write **never** fails the app-switcher read response.

### 2. Route post-login

`getDefaultPostLoginTarget()` (`src/lib/apps.ts`) selects the target org as:

1. If `lastOrgId` is set **and** matches a current membership → that org's Nexus.
2. Else the **oldest** membership (`orderBy: createdAt asc`) → that org's Nexus.
3. If **0 memberships** → `/account` (org-less fallback).

Superadmins without `preferWorkspace: true` still land on `getPlatformAdminUrl()`. The `buildTenantWorkspaceUrl` helper handles dev/prod/on-prem URL derivation.

### 3. Thread `lastOrgId` through all resolution callsites

`login`, `continue` (both access and refresh paths), `magic-link/verify`, `oauth/google/callback`, `oauth/github/callback`, and `resolvePostLoginTarget` in `session-redirect.ts` all pass `lastOrgId` into target resolution.

## Consequences

- Multi-org users land on their **most-recently-used Nexus tenant** instead of `/account` after login.
- `/account` is demoted to a **settings / org-management hub**, not the auto-landing page.
- `lastOrgId` can be **stale** (user removed from the org) — resolution falls back to the oldest membership gracefully; `onDelete: SetNull` ensures no FK violations.
- The `lastOrgId` update is **best-effort**: a transient DB error never fails the app-switcher read.
- **Migration guard (cortex ADR-128):** the Prisma migration adding `lastOrgId` requires human approval before merging.
