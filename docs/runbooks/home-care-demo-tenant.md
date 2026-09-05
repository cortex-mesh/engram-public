# Ally Home Care tenant seed

This runbook provisions the PHI-free Ally Home Care tenant in Engram for the
home-care AI-intake prototype (ADR-019). It is also the canonical way to
reprovision the `ally` tenant after a destructive reset of the aws-dev RDS.

## Scope

The seed script creates or updates only Engram identity/control-plane records:

- organization: `Ally Home Care` / `ally` (tenant URL: `ally.dev.ctxhost.com`)
- owner user: `ally.owner@ctxhost.local` / `ally-owner`
- member user: `ally.member@ctxhost.local` / `ally-member`
- app entitlements: `synapse`, `pulse`, `thoughts`
- feature entitlements: none (add `thoughts.projects` if project boards are needed)
- org memberships: owner as `OWNER`, member as `MEMBER`

The fixture is intentionally fake. Do not add clinical records, insurance,
billing, real patient/client/caregiver details, or any other PHI to this
tenant. Contact and care-need demo data for downstream apps is acceptable only
when it remains synthetic.

## Manual provisioning only

Do not expose this path through public signup. Run it manually from an operator
shell with an explicit database URL for the intended non-production Engram
database.

Do not run against production databases. Ensure `DATABASE_URL` points to the
correct aws-dev Engram RDS (obtained from Secrets Manager or the engram-db-query
runbook recipe in the cortex-mesh meta-repo memory).

## Seed command

From the Engram repo:

```bash
DATABASE_URL='postgresql://...' \
npm run seed:demo:ally
```

Equivalent explicit command:

```bash
DATABASE_URL='postgresql://...' \
DEMO_TENANT_PRESET=ally \
node scripts/seed-demo-tenant.mjs
```

Passwords are generated automatically and printed unless `DEMO_PRINT_PASSWORDS=0`
is set. Persist the printed passwords to `~/.secrets/ally-tenant-test.env`:

```bash
ALLY_OWNER_EMAIL=ally.owner@ctxhost.local
ALLY_OWNER_PASSWORD=<printed>
ALLY_MEMBER_EMAIL=ally.member@ctxhost.local
ALLY_MEMBER_PASSWORD=<printed>
```

The script is idempotent. Re-running it upserts the organization, users,
memberships, and entitlements by stable slugs/emails/keys.

## Resetting passwords

For an existing tenant, rotate the fixture passwords by adding `DEMO_RESET_PASSWORDS=1`:

```bash
DATABASE_URL='postgresql://...' \
DEMO_RESET_PASSWORDS=1 \
npm run seed:demo:ally
```

If password variables are omitted while `DEMO_RESET_PASSWORDS=1` is set, the
script generates fresh random passwords and prints them unless
`DEMO_PRINT_PASSWORDS=0` is set.

## Tenant overrides

The ally preset can be overridden for a one-off local fixture using the `DEMO_*`
environment variables:

- `DEMO_ORG_NAME`
- `DEMO_ORG_SLUG`
- `DEMO_OWNER_EMAIL`
- `DEMO_OWNER_USERNAME`
- `DEMO_OWNER_DISPLAY_NAME`
- `DEMO_MEMBER_EMAIL`
- `DEMO_MEMBER_USERNAME`
- `DEMO_MEMBER_DISPLAY_NAME`

Prefer the default preset values for the shared ally tenant so cross-repo
scripts and the intake prototype can target a stable tenant.

## Verification

After a successful run, confirm the script output includes:

- `Seeded demo organization: Ally Home Care (ally)`
- `Tenant URL: https://ally.dev.ctxhost.com/`
- `App entitlements: synapse, pulse, thoughts`
- `Feature entitlements: (none)`

Optional SQL verification (replace `<org-id>` with the ally org id):

```sql
SELECT name, slug FROM "Organization" WHERE slug = 'ally';
SELECT "appKey", enabled FROM "OrgAppEntitlement" WHERE "orgId" = '<org-id>' ORDER BY "appKey";
SELECT email, username, "displayName" FROM "User" WHERE email LIKE '%@ctxhost.local' AND email LIKE 'ally%';
```

## Security gate before real pilot data

The Engram `docs/security-audit-2026-05-20.md` findings are acceptable to defer
only for this fake-data prototype tenant. Treat those findings as hard gates
before any real pilot data, PHI, client records, caregiver records, billing data,
or production provisioning enters Engram or connected suite apps. See D8 in the
intake prototype goal prompt (`docs/plans/2026-06-13-ally-home-care-prototype-goal-prompt.md`).
