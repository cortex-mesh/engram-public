# ADR-009: Per-User App Entitlements (Default-Allow with Explicit Deny)

**Status:** Proposed
**Date:** 2026-04-29
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-005 (Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements), ADR-006 (Engram Superadmin Console), ADR-008 (Human Users and Agent Service Principals), Pulse ADR-007 / 008 / 011 (tenant lockdown + no-access page)

## Context

ADR-005 established **org-level** app entitlements (`OrgAppEntitlement`, keyed by `(orgId, appKey)`). When an org has Pulse enabled, every member of that org has access to Pulse. There is currently no way to deny one specific member without removing them from the org or disabling the app for the whole org.

This is starting to bite:

- A cortex org member who shouldn't see CRM data still gets `/pulse` access if the org has the `pulse` entitlement.
- An OWNER cannot say "Alice gets Pulse, Bob doesn't" without inventing parallel orgs or removing Bob entirely.
- The hosted suite is growing — once more apps land in Nexus, the granularity gap will become routine instead of edge-case.

The Pulse multi-tenant lockdown (ADR-007 / 008 / 011) hardened the **org boundary** — a signed-in user from org A cannot see org B's data, and an org without the `pulse` entitlement gets a friendly `/pulse/no-access?reason=missing_entitlement` page. What that work explicitly did **not** do is gate access at the user level inside an entitled org. This ADR closes that gap.

The existing org-level model, the SUPERADMIN authority chain, the AuthFailureReason routing in Pulse, and `authenticateInputs({token,host})` are all good — we extend them, we don't replace them.

## Decisions

### D1. Default-allow, explicit-deny model

**Decision:** When an org has an app entitled, every org member has access to that app **by default**. Per-user entitlement is an **explicit override layer** — its only job today is to revoke a specific user's access without affecting the rest of the org.

Effective admission for a tenant user becomes (extending ADR-005 §6):

1. user is authenticated by Engram
2. user is a current member of the target org
3. the org has the app enabled
4. the user does **not** have an explicit `enabled=false` `UserAppEntitlement` row for that `(orgId, appKey)`

Absence of a row means "use the default", which today is allow.

**Rationale:**

- Preserves current behavior at rollout — no existing user loses access on the day this ships.
- Matches user expectation: "we want the ability to deny access" is asymmetric, not symmetric.
- Mirrors how `OrgAppEntitlement.enabled` already works (boolean column rather than separate grant/revoke tables).
- Leaves room to flip an org's default policy to "deny" later (under a separate ADR) without redesigning the schema.

### D2. New `UserAppEntitlement` model in Engram

**Decision:** Add a new Prisma model:

```prisma
model UserAppEntitlement {
  id        String       @id @default(cuid())
  user      User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId    String
  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  orgId     String
  appKey    AppKey
  enabled   Boolean
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
  createdByUserId String?
  updatedByUserId String?

  @@unique([userId, orgId, appKey])
  @@index([orgId, appKey])
}
```

Notes:

- The unique key is `(userId, orgId, appKey)` — a user can have at most one explicit override per app per org they belong to.
- `enabled=false` is the load-bearing case (revocation). `enabled=true` rows are accepted and harmless — they will appear as a no-op against today's default-allow but become meaningful if a future ADR introduces default-deny modes.
- `createdByUserId` / `updatedByUserId` are nullable audit columns so we can show "Bob revoked by Alice" in the admin UI later. They are not used for authorization.
- No FK to `OrgAppEntitlement`. The override table is independent — revoking a user's row does not require the org row to exist, and the runtime check resolves both rows.

### D3. Authority: SUPERADMIN + org OWNER/ADMIN

**Decision:** Per-user entitlements can be created, updated, or deleted by:

- platform `SUPERADMIN` — for any org, any app
- org `OWNER` or `ADMIN` — only for their own org, only for apps the org is **already entitled to**

An OWNER/ADMIN cannot grant access to an app the org doesn't have — that's still a SUPERADMIN-only platform action (ADR-005 §2). They can only narrow a subset of their org's existing entitlements per user.

`MEMBER` cannot manage user-level entitlements.

**Rationale:** Lets tenant admins self-serve "Alice gets Pulse, Bob doesn't" without escalating every personnel decision to platform staff. The platform retains exclusive authority over the org-level rollout boundary.

### D4. API surface (Engram)

**Decision:** Add the following routes under the existing org/admin namespace, mirroring the shape of `app-entitlements/route.ts`:

- `GET /api/orgs/:orgId/users/:userId/app-entitlements` — list explicit overrides for one user in one org. Auth: SUPERADMIN, or an OWNER/ADMIN of `:orgId`.
- `PUT /api/orgs/:orgId/users/:userId/app-entitlements` — body `{ appKey, enabled }`. Upserts. Same auth as GET; OWNER/ADMIN additionally requires the org has `(orgId, appKey)` entitled with `enabled=true`.
- `DELETE /api/orgs/:orgId/users/:userId/app-entitlements/:appKey` — removes the explicit override row, restoring default behavior. Same auth.
- `GET /api/orgs/:orgId/app-entitlements/:appKey/users` — list users in this org with explicit overrides for this app (admin UI rollup). SUPERADMIN + OWNER/ADMIN of the org.

Cross-origin cookie writes are rejected the same way as the existing entitlement routes.

### D5. Delivery to consumer apps: extend the existing auth chain, no JWT change

**Decision:** The JWT format is unchanged. Per-user entitlements are resolved server-side, per request, in the same chain Pulse already uses:

- Engram exposes the user's current org+app effective admission via the existing internal endpoint (`/api/orgs?userId=…` or equivalent — extend the response payload to include `userAppOverrides: [{ orgId, appKey, enabled }]` for the authenticated user).
- Pulse's `authenticateInputs({token,host}) → fetchEngramOrgs → resolveOrProvisionTenant` chain (see `pulse/src/lib/engram-auth.ts`) gains one new derivation step: after computing whether the resolved org has `pulse` org-entitled, it checks whether the same user has an explicit `enabled=false` override for `(resolvedOrgId, "pulse")` and, if so, fails closed.
- `hasPulseEntitlement(...)` → returns `false` if either the org-level entitlement is missing/disabled **or** an explicit user-level override denies it.

JWT claims remain `(sub, orgs[])` shaped. We do not embed entitlements — staleness and cookie bloat outweigh the per-request DB read, and the read is on the same already-warm path.

**Rationale:** Zero migration cost for existing token holders, no rotation forced on revoke, and the enforcement code stays in one place. Same pattern Synapse / Thoughts / Axon will adopt when they integrate.

### D6. Pulse enforcement and the `/no-access` page

**Decision:** Pulse's `AuthFailureReason` enum (introduced by ADR-011) gains a new value: `user_app_revoked`. The routing matrix updates:

| Reason | Outcome |
| --- | --- |
| `missing_token` | redirect to Engram `/api/auth/continue` |
| `invalid_token` | redirect to Engram `/api/auth/continue` |
| `no_matching_org` | redirect to `/pulse/no-access?reason=no_matching_org` |
| `missing_entitlement` | redirect to `/pulse/no-access?reason=missing_entitlement` |
| `member_unprovisioned` | redirect to `/pulse/no-access?reason=member_unprovisioned` |
| **`user_app_revoked`** (new) | redirect to `/pulse/no-access?reason=user_app_revoked` |

Per-reason copy on the no-access page (matching ADR-011 §D3 style):

- **user_app_revoked** — "Your access to Pulse in this organization has been revoked. Ask an OWNER or ADMIN to restore it."

This deliberately reads differently from `missing_entitlement` ("Pulse isn't part of your org's app entitlements; admin enables it from Engram") because the action needed is different — `missing_entitlement` requires a **platform** SUPERADMIN; `user_app_revoked` can be resolved by a **tenant** OWNER/ADMIN.

### D7. SUPERADMIN bypass remains absolute

**Decision:** Per the standing project memory (`feedback_superadmin_access.md`), platform SUPERADMINs bypass per-user entitlement checks the same way they bypass tenant scoping in Pulse. A SUPERADMIN with an `enabled=false` row on themselves still gets through; the row exists for audit completeness only.

**Rationale:** Consistent with every other access control in the suite. We do not invent a special case.

### D8. Audit and observability are out of scope

**Decision:** This ADR adds the `createdByUserId` / `updatedByUserId` columns but does **not** ship a separate audit log table, an admin event stream, or analytics. A future ADR can layer audit on top once we have ≥1 production tenant with multiple admins.

**Rationale:** Pre-mature for the current scale. The columns make the future migration trivial.

## Implementation status

Not started. After acceptance, the rollout below applies.

## Authorization matrix (delta from ADR-005)

| Action | MEMBER | ADMIN | OWNER | SUPERADMIN |
| --- | --- | --- | --- | --- |
| List own user app entitlements (any org they're in) | Yes | Yes | Yes | Yes |
| List another user's app entitlements in same org | No | Yes | Yes | Yes |
| Grant/revoke a user's app entitlement in own org (org-entitled apps only) | No | Yes | Yes | Yes |
| Grant/revoke a user's app entitlement in any org | No | No | No | Yes |
| Grant/revoke an app the org isn't entitled to | No | No | No | Yes (via `OrgAppEntitlement`, separate action) |

## Rollout

1. **Engram PR A — schema + API.** Land `UserAppEntitlement` migration + four routes from D4. Unit tests cover the SUPERADMIN, OWNER/ADMIN, and MEMBER paths and the "OWNER cannot grant an app the org doesn't have" guard. No UI yet.
2. **Engram PR B — superadmin console UI.** Add the per-user override editor under `/admin/clients/[orgId]` (existing route from ADR-006). Tenant-side OWNER/ADMIN UI is a separate later PR; SUPERADMIN-only first.
3. **Pulse PR C — enforcement + no-access reason.** Extend `engram-auth.ts → authenticateInputs` and `hasPulseEntitlement` per D5. Add `user_app_revoked` to `AuthFailureReason`, branch in `requireTenantContext` / `resolveTenantContext`, add no-access copy and tests. Mirror the ADR-011 test pattern.
4. **Live verification on `cortex-dev-app-host`.** Use `hermes-test` (cortex MEMBER, all five apps enabled) as the probe: SUPERADMIN flips `enabled=false` for `(cortex, pulse, hermes-test)` → expect `/pulse/no-access?reason=user_app_revoked` on next request. Flip back → expect access restored without re-login.
5. **Other consumer apps (Synapse, Thoughts, Axon, Dashboard).** Out of scope for this ADR's PRs but the contract is now defined; each can adopt the same `hasAppEntitlement(userId, orgId, appKey)` helper at its own pace.

## Considered options

### Option A: User-level grant table (default-deny)

Make per-user entitlement the **only** source of truth — drop or ignore org-level entitlements at runtime. Rejected: every existing org member would lose access on rollout day unless backfilled, and the "org has Pulse" concept is still useful for billing, packaging, and SUPERADMIN-only platform control. Org-level remains the **outer** gate; user-level is the inner override.

### Option B: Embed entitlements in the JWT

Bake `(orgId, appKey, enabled)` tuples into the access token. Rejected: 15-minute staleness window on revoke is unacceptable for a deny-control feature ("we revoked Bob but he kept reading tickets for 14 minutes"), and the cookie size grows linearly with apps × orgs. The per-request Engram call already happens; one more field in the response is free.

### Option C: A single `enabled` column with `null` meaning "default"

Three-state column instead of "row exists or doesn't". Rejected: adds nothing over the row-presence model and complicates the unique constraint. Prisma upserts on `(userId, orgId, appKey)` are clean.

### Option D: Apply the same model to feature entitlements in this ADR

Symmetric per-user feature entitlements alongside per-user app entitlements. Rejected for **this** ADR — the user request is explicitly app-level, feature flags have a different rollout cadence (typically platform-controlled, not tenant-controlled), and we have only two feature entries today (`thoughts.projects`, `thoughts.adr`). A separate ADR can extend if/when needed.

### Option E: Service principals / agents in the same model

Use the same `UserAppEntitlement` table for human users and agent principals. Rejected: ADR-008 deliberately separated agent/service principals from human `OrgMember` records. Agent app capabilities should follow that separation; a future ADR can introduce `AgentAppEntitlement` with the same shape.

## Consequences

### Positive

- Tenant admins gain a real "deny one user" lever without org splits or app-wide flips.
- The schema, API shape, and enforcement chain extend the existing patterns instead of inventing new ones.
- Default-allow rollout is a no-op for current users — no migration script, no backfill.
- The contract is defined once in Engram; other consumer apps adopt it on their own timeline.
- The new `user_app_revoked` no-access reason gives revoked users a clear, actionable message and points them at the right authority (OWNER/ADMIN, not platform).

### Negative

- One extra DB read per authenticated request to Pulse (folded into the existing `fetchEngramOrgs` round-trip). Acceptable at current traffic.
- One more table to keep clean — a stale `enabled=true` row on a user who has been removed from the org is harmless but visually noisy in admin tools.
- Two layers of "is this user entitled" — org-level and user-level — means the logic in `hasPulseEntitlement` grows slightly. Mitigated by keeping it in one helper.

### Risks

- **Tenant-admin abuse of revocation.** An OWNER could revoke another OWNER's access to one app. Acceptable: it's already true at the org level (an OWNER can demote another OWNER), and SUPERADMIN can always restore. Document in the runbook.
- **Confusion between `missing_entitlement` and `user_app_revoked`.** Mitigated by distinct copy and the reason-routed no-access page (ADR-011).
- **Drift between Engram and Pulse adoption order.** If Pulse PR C ships before Engram PR A, Pulse's helper will look up a table that doesn't exist. Mitigated by sequencing: Engram first, Pulse second.

## What this ADR does NOT do

- Does not change `OrgAppEntitlement` or `OrgAppFeatureEntitlement` schemas or semantics.
- Does not introduce per-user **feature** entitlements (Option D — future ADR if needed).
- Does not extend the model to agent / service principals (Option E — future ADR per ADR-008's separation).
- Does not change JWT format or the `ENGRAM_JWT_SECRET` rotation contract.
- Does not ship the tenant-side OWNER/ADMIN UI for per-user entitlements (SUPERADMIN console first; tenant UI in a follow-up).
- Does not add an audit log table; audit columns are scaffolded but not surfaced.
- Does not address the open MEMBER read-only gap on Pulse mutations (separate follow-up flagged in project memory).

## Links

- ADR-001: Engram identity service — `docs/adr/ADR-001-engram-identity-service.md`
- ADR-005: Org-level app + feature entitlements — `docs/adr/ADR-005-suite-roles-org-roles-and-app-entitlements.md`
- ADR-006: Superadmin console — `docs/adr/ADR-006-engram-superadmin-console.md`
- ADR-008: Human users and agent service principals — `docs/adr/ADR-008-human-users-and-agent-service-principals.md`
- Pulse ADR-011: friendly no-access page (the routing pattern this ADR extends) — `../../pulse/docs/adr/ADR-011-no-access-page.md`
- Pulse ADR-007 / 008: tenant lockdown (the enforcement chain this ADR plugs into)
- Engram entitlement route to mirror: `engram/src/app/api/orgs/[orgId]/app-entitlements/route.ts`
- Pulse helper to extend: `pulse/src/lib/engram-auth.ts → authenticateInputs`, `hasPulseEntitlement`
