# Engram Superadmin Console Implementation Plan

> For Hermes: Use test-driven-development and requesting-code-review while executing this plan.

Goal
- Add a hosted-suite superadmin console to Engram so platform operators can manage clients, users, apps, and feature flags from a dashboard-like shell.

Architecture
- Keep global hosted admin UX in Engram because Engram owns users, orgs, memberships, app entitlements, and feature entitlements.
- Build `/admin/*` server-rendered pages backed by shared data-loader helpers, with small client components only where toggles are needed.
- Reuse existing entitlement mutation APIs for org app/feature toggles instead of inventing a second mutation path.

Scope
- Overview page
- Clients list
- Client detail page with members, roles, app toggles, feature toggles
- Users directory
- Apps catalog
- Feature registry
- Dashboard-like sidebar and header shell
- Account-page link for superadmins
- Docs updated to reflect the current hosted control-plane state

Non-goals
- Billing
- Audit log
- Custom domains
- App-local role editing inside consumer apps

Key files expected to change
- `docs/adr/ADR-005-suite-roles-org-roles-and-app-entitlements.md`
- `docs/adr/ADR-006-engram-superadmin-console.md`
- `docs/adr/README.md`
- `docs/architecture-audit.md`
- `docs/integrations.md` (new)
- `README.md`
- `src/lib/apps.ts`
- `src/lib/admin-console.ts` (new)
- `src/app/admin/layout.tsx` (new)
- `src/app/admin/page.tsx` (new)
- `src/app/admin/clients/page.tsx` (new)
- `src/app/admin/clients/[orgId]/page.tsx` (new)
- `src/app/admin/users/page.tsx` (new)
- `src/app/admin/apps/page.tsx` (new)
- `src/app/admin/features/page.tsx` (new)
- `src/components/admin/*` (new)
- `src/app/(auth)/account/page.tsx`
- `tests/lib/apps.test.ts` (new)
- `tests/lib/admin-console.test.ts` (new)

Task breakdown

1. Write failing tests for app catalog metadata and admin data aggregation.
2. Implement richer app/feature catalog metadata in `src/lib/apps.ts`.
3. Implement `src/lib/admin-console.ts` data loaders for overview, clients, client detail, users, apps, and features.
4. Run targeted tests, then `npm run typecheck`.
5. Build admin shell components (sidebar/header/section frame).
6. Add `/admin` overview page.
7. Add `/admin/clients` and `/admin/clients/[orgId]` pages.
8. Add client-side toggles for app and feature entitlements using existing APIs.
9. Add `/admin/users`, `/admin/apps`, and `/admin/features` pages.
10. Add account-page entry point for superadmins.
11. Update docs to reflect the implemented hosted control plane and current runtime contract.
12. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
13. Request code review before pushing.
14. Push branch, open PR, watch CI, merge when green.

Verification
- superadmin can access `/admin/*`
- non-superadmin is denied or redirected away from `/admin/*`
- clients page lists all orgs
- client detail shows members/roles plus app and feature toggles
- users page shows org membership summaries
- apps and features pages reflect current catalog/registry
- toggling app/feature entitlements succeeds using existing APIs
- docs match the live control-plane model
