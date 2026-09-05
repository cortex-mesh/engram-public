# ADR-019: Per-Preset Entitlements and the `ally` Org Preset

**Status:** Accepted
**Date:** 2026-06-13
**Deciders:** Roland Parnaso (per the Ally Home Care intake prototype goal prompt, 2026-06-13)
**Related:** ADR-005 (Suite roles, org roles, and app entitlements), ADR-010 (Consumer app admission pattern), `scripts/seed-demo-tenant.mjs`, `docs/runbooks/home-care-demo-tenant.md`, Pulse ADR-017 (tenant-aware vertical branding), cortex ADR-123 (ally org cloud agent)

## Context

`scripts/seed-demo-tenant.mjs` seeds demo-style tenants for development and
demonstration. Today it applies a **single global `APP_ENTITLEMENTS` constant**
(`["synapse","thoughts","pulse","gyrus"]`) to every org it creates. This means
every preset — `default` (demo org) and `HOME_CARE_DEMO_CONFIG` — gets the
same app entitlement set regardless of the org's intended purpose.

Two problems surfaced when adding the `ally` org for the Ally Home Care
intake prototype:

1. **Ally should not have `gyrus` (personal net-worth tracker) or `axon`
   (financial intelligence)** — those apps have no place in a home-care
   agency's suite. The entitlement set must be `{synapse, pulse, thoughts}`
   only (goal-prompt Decision D2).
2. **`demo` must be left untouched.** Any change to the global constant would
   silently alter the live `demo` org's entitlements, breaking the neutral
   cross-suite test fixture.

The fix is to move from a single global constant to **per-preset entitlement
declarations**: each preset carries its own `appEntitlements` (and optionally
`featureEntitlements`). The seeder reads from the preset rather than the
global. Demo's effective set is preserved exactly.

A secondary goal: the existing `HOME_CARE_DEMO_CONFIG` uses slug
`ally-home-care-demo`; the new `ally` preset uses slug `ally` (a dedicated
production-track tenant, not a generic demo label) so it maps to
`ally.dev.ctxhost.com`.

## Decision

### 1. Per-preset entitlement declaration

Replace the global `APP_ENTITLEMENTS` constant in `seed-demo-tenant.mjs` with
a per-preset field `appEntitlements: string[]` (required, no default). Each
existing and future preset declares its own set. The seeder iterates
`preset.appEntitlements` when writing `OrgAppEntitlement` rows.

Demo preset entitlements are set to match the live `demo` org on aws-dev.
The current seed-script constant is `["synapse","thoughts","pulse","gyrus","tradepost"]`
(note: `axon` is absent from the constant but may be present in the live RDS —
the implementer must verify the live `OrgAppEntitlement` rows for the `demo` org
against the aws-dev RDS **before merging** and adjust the demo preset accordingly).

### 2. The `ally` org preset

Add a new preset constant `ALLY_ORG_CONFIG` and npm script `seed:demo:ally`:

```
{
  slug:        "ally",
  displayName: "Ally Home Care",
  users: [
    {
      email:       "ally.owner@ctxhost.local",
      displayName: "Ally Owner",
      role:        "OWNER",
    },
    {
      email:       "ally.member@ctxhost.local",
      displayName: "Ally Member",
      role:        "MEMBER",
    },
  ],
  appEntitlements: ["synapse", "pulse", "thoughts"],
}
```

Passwords are generated and printed the same way as the `demo` preset
(`DEMO_PRINT_PASSWORDS` / `DEMO_RESET_PASSWORDS` env vars). The calling
operator persists them to `~/.secrets/ally-tenant-test.env`; they are never
committed.

### 3. npm script

```
"seed:demo:ally": "DEMO_TENANT_PRESET=ally node scripts/seed-demo-tenant.mjs"
```

The seeder reads `DEMO_TENANT_PRESET` and dispatches to the matching preset
config. Both `seed:demo` and `seed:demo:home-care` (if present) remain
unchanged.

### 4. Runbook update

`docs/runbooks/home-care-demo-tenant.md` is updated to reference the `ally`
slug and the `seed:demo:ally` script in the same PR.

## Consequences

- `demo` org's entitlement set is **unchanged** on aws-dev; the refactor is
  validated against the live RDS before merge.
- The `ally` org can be provisioned idempotently at any time via
  `seed:demo:ally`; running it a second time is safe (upserts, not inserts).
- Any future preset can carry a tailored entitlement set; the global constant
  is gone.
- Feature entitlements (`OrgAppFeatureEntitlement`) follow the same pattern
  if a preset needs them; `ally` v1 does not define any.

## Follow-ups

- **Auto-provision on org create**: the Ally org is provisioned manually via
  the seed script; general auto-provisioning of entitlements at org-create
  time is tracked as a follow-up (not in scope for this goal).
- **`HOME_CARE_DEMO_CONFIG` removal is required in the Phase 1 PR** (not
  optional): the existing `selectTenantPreset` function maps the key `"ally"`
  as an alias to `HOME_CARE_DEMO_CONFIG`. When `ALLY_ORG_CONFIG` is added
  and dispatches on `"ally"`, this alias creates a collision. The old preset
  and its `"ally"` (and `"ally-home-care"`, `"ally-home-care-demo"`) aliases
  in `selectTenantPreset` **must be removed in the same PR** that adds the
  new preset, not deferred as a conditional cleanup.
- **Feature entitlement `thoughts.projects`**: the old `HOME_CARE_DEMO_CONFIG`
  preset granted `thoughts.projects` to the `ally-home-care-demo` org. The
  new `ally` v1 preset **intentionally omits this** (the intake prototype
  does not need project boards). Add it if the ally tenant needs Thoughts
  project boards during testing.
