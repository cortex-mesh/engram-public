# ADR-030: Per-Member App Access Control (Restricted-Access Apps)

**Status:** Accepted
**Date:** 2026-07-22
**Deciders:** Roland
**Related:** ADR-005 (org roles & app entitlements), ADR-010 (org-tenant app admission), ADR-019 (per-preset entitlements), ADR-020 (tenant-admin OWNER/ADMIN API), ADR-027 (consumer-client admission); gyrus ADR-007 (Engram auth/admission), gyrus ADR-022 (writer-grant management UI)

## Context

Org→app access in the mesh is **org-wide and binary**. `OrgAppEntitlement(orgId, appKey, enabled)` decides whether an app is available to an organization; if enabled, **every member of that org is admitted** to the app. Apps consume this by reading their org's `appEntitlements` from `GET /api/orgs` and admitting any member of an entitled org (see gyrus ADR-007's `hasGyrusEntitlement`).

A per-user override table already exists — `UserAppEntitlement(userId, orgId, appKey, enabled)` — surfaced to each app, caller-scoped, as `userAppOverrides` in the org summary (`src/app/api/orgs/route.ts` filters `where: { userId: auth.userId }`). But today it is only meaningfully used in the **deny** direction: an app treats `enabled=false` as "revoke this member," and absence as "allowed." There is no first-class way to say *"this app is available to only a named subset of the org's members."*

**What forced the issue (gyrus).** Gyrus is a net-worth/budget tracker with no per-user data isolation — every admitted member of a tenant sees the same financial workspace. Roland runs it inside the shared `cortex` org and wants it visible to **only himself and his wife (a `MEMBER`)** — explicitly *not* the org's other members (e.g. Ryan), who should not have access or even be aware the app exists. With the current model that is impossible to express cleanly:

- The `cortex` org has `gyrus` entitled, so **every** cortex member is admitted — the private financial data is readable by every member today (the only thing obscuring it is that Nexus doesn't render a gyrus launcher tile).
- The only lever is a per-user **deny** for every member who *shouldn't* have access — fragile (any newly-added member is admitted by default) and disclosing (a denied member still learns the app exists).

The clean primitive is missing: **an app entitlement that is restricted to an explicit allow-list of members.** This is a general mesh capability — synapse, thoughts, pulse, and future apps will want "available to the whole org" *and* "available to specific people" — so it belongs in Engram (the owner of membership and entitlements), consumed uniformly by apps, not reinvented per app. (A gyrus-local `AccessGrant` was considered and rejected — see Alternatives.)

## Decisions

### D1. A per-app **access mode** on `OrgAppEntitlement`

Add an `accessMode` enum to the org→app entitlement:

```prisma
enum AppAccessMode {
  ALL_MEMBERS   // default — every org member is admitted (today's behavior)
  RESTRICTED    // default-deny — only allow-listed members (+ owners/admins/superadmin)
}

model OrgAppEntitlement {
  // ... existing fields ...
  accessMode AppAccessMode @default(ALL_MEMBERS)
}
```

`ALL_MEMBERS` reproduces today's semantics exactly, so **every existing org/app is unchanged** by the migration. `RESTRICTED` flips the default to deny: a member is admitted only if explicitly allow-listed.

### D2. `UserAppEntitlement` is the allow/deny list; the mode fixes the default

No new table — reuse `UserAppEntitlement(userId, orgId, appKey, enabled)`, with semantics keyed off `accessMode`:

- **`ALL_MEMBERS` mode** — absence = allowed (default); `enabled=false` = **deny** (remove this member). Unchanged from today.
- **`RESTRICTED` mode** — absence = denied (default); `enabled=true` = **allow** (add this member to the list). `enabled=false` rows are redundant (already default-deny) but harmless.

So the same row means "deny" under one mode and the list is the allow-list under the other; the mode is what changes the default, not the row.

### D3. Engram computes **effective access**; the algorithm is the contract

The single source of truth for "may this user open this app in this org":

```
canAccessApp(user, org, app):
  if user.platformRole == SUPERADMIN:              return true
  ent = OrgAppEntitlement(org, app)
  if ent is null or ent.enabled == false:          return false     # app not entitled to the org
  ovr = UserAppEntitlement(user, org, app)          # may be absent
  if ent.accessMode == ALL_MEMBERS:
      return ovr?.enabled != false                  # allowed unless an explicit deny
  else: # RESTRICTED
      if orgRole(user, org) in {OWNER, ADMIN}:      return true      # admins administer the org
      return ovr?.enabled == true                   # members: allow-listed only
```

Notes:
- **OWNER/ADMIN retain access to a RESTRICTED app.** They administer the org and manage its allow-list; auto-including them removes the "restrict an app and lock yourself out" footgun. Excluding even admins is a deliberately stricter posture we can add later (an `owners_included` flag) if a use-case needs it; it is out of scope here.
- **SUPERADMIN always passes** — consistent with existing admission (gyrus ADR-007). This is why Roland (a platform SUPERADMIN) can already open cortex/gyrus regardless of entitlement, and why the exposure above was easy to miss.

### D4. Expose a computed `appAccess` in the org summary; apps consume that, not raw entitlements

`GET /api/orgs` gains a caller-scoped, pre-computed field per organization:

```jsonc
"appAccess": [ { "appKey": "gyrus", "canAccess": true }, ... ]   // only apps entitled to the org
```

Apps replace their bespoke admission derivation (org entitlement + ad-hoc override checks) with a single membership test against `appAccess`. Engram owns the algorithm (D3); apps never re-implement it. The existing `appEntitlements` and `userAppOverrides` fields remain during migration (D7) so un-migrated apps keep working; new/updated apps read `appAccess`.

### D5. Management surface — set the mode and edit the allow-list

Extend the existing admin surfaces (no new authz model — reuse ADR-020's OWNER/ADMIN tenant-admin API + the platform-admin superadmin console):

- **Per-app access mode** toggle (ALL_MEMBERS ↔ RESTRICTED) on the org's Apps card.
- **Per-member app access** editor: for a RESTRICTED app, add/remove members on the allow-list; for an ALL_MEMBERS app, add/remove per-user denies. Writes `UserAppEntitlement` rows (`createdByUserId`/`updatedByUserId` already exist for audit).

This is where an OWNER/ADMIN (or superadmin) marks `gyrus` RESTRICTED for `cortex` and allow-lists Roland + his wife.

### D6. Consumer contract — apps check `appAccess`, and privacy-sensitive apps stay silent

- Apps admit iff `appAccess` contains their `appKey` with `canAccess: true`. Concretely, gyrus (ADR-007/022) replaces `hasGyrusEntitlement` + `hasGyrusUserDenyOverride` with the single `appAccess` check; its per-user *writer* grant (gyrus ADR-021) is unaffected — access gates admission, the writer grant still gates mutation *after* admission.
- **Non-disclosure for restricted apps:** a member denied by a RESTRICTED entitlement SHOULD receive a generic *not-found*, not an app-branded "no access" page, so the app's existence isn't revealed. This is an app-side responsibility (gyrus adopts it); Engram's contract is only the `canAccess` boolean.

### D7. Back-compat and rollout

- **Migration** adds `AppAccessMode` + the `accessMode` column defaulting `ALL_MEMBERS` — additive, non-destructive, no behavior change for any existing org/app.
- **Incremental app adoption**: until an app reads `appAccess`, it keeps working via the retained `appEntitlements`/`userAppOverrides` fields (the `ALL_MEMBERS` path is exactly today's behavior). No coordinated cutover.
- **Sequence**: (1) Engram — schema + `canAccessApp` + `appAccess` in the summary + admin UI; (2) gyrus — consume `appAccess` + non-disclosure response; (3) operator — mark `cortex`/`gyrus` RESTRICTED and allow-list Roland + wife. Only at step 3 does anyone's access change.
- **Cache caveat**: gyrus caches the Engram org summary per token for up to ~900s (gyrus ADR-007). A revoked allow can therefore linger up to that TTL on an already-issued token; acceptable for this class of app, but the admin UI should say so, and security-critical revocations may warrant a shorter TTL or a cache-bust (follow-up, not required here).

## Consequences

**Positive**
- Per-member app access becomes a first-class, mesh-wide capability owned by Engram; "private app for a subset of the org" is a natural state, not a per-member deny chore.
- Apps get it for free by reading one computed field; no per-app reinvention (gyrus's bespoke checks collapse to one).
- Fully backward-compatible; nothing changes until an app is explicitly marked RESTRICTED.

**Negative / risks**
- **Empty-allow-list footgun**: marking an app RESTRICTED with no allow-listed members denies all non-admin members at once. Mitigated by OWNER/ADMIN auto-access (D3) and a clear admin UI; a confirm step is advisable.
- **Adoption gap**: an app that hasn't migrated to `appAccess` ignores RESTRICTED mode and keeps admitting all members — RESTRICTED is only enforced once the app consumes `appAccess`. The rollout must not mark an app RESTRICTED before that app has adopted the contract (else a false sense of restriction). Track per-app adoption.
- **Revocation latency** bounded by the app's org-summary cache TTL (D7).

## Alternatives considered

- **Gyrus-local `AccessGrant`** (a per-tenant "may view" grant inside gyrus, sibling to its writer grant). Rejected: it reinvents in one app what every app will want, and puts an access-control primitive below the identity plane that owns membership. Access control belongs in Engram; gyrus should only *consume* it.
- **Model B — default-allow + per-user deny only** (no access mode). Rejected: expressing "private to two of six members" requires denying everyone else and re-denying every future member — fragile and disclosing. RESTRICTED mode makes default-deny the state, not a maintenance task.
- **Separate org/tenant per private app** (move gyrus data into a 2-person org). Rejected for this need: heavier (new org + data migration) and loses the shared-org convenience; the per-member gate solves it without moving data. Remains available for cases that want hard tenant isolation.
