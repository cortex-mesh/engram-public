# ADR-032: Production migration drift tracking + gated auto-apply

**Status:** Accepted (2026-07-22)

**Relates to:** ADR-025 (prod serverless build; §11 human-gated prod migrations) · cortex ADR-128 (migration-guard: additive-auto / destructive-human). Motivated by the 2026-07-22 prod-500 incident (`docs/incidents/2026-07-22-refresh-grace-prod-500.md`), whose root enabler was undetected schema drift.

## Context

Engram's schema is managed by Prisma migrations. How they reach each environment differs:

- **dev / on-prem:** `cortex app deploy engram --env <profile>` runs `prisma migrate deploy` as part of the deploy (the app host can reach the DB), so these environments stay current automatically on every merge to `main`.
- **aws-prod:** `deploy-prod.yml` runs `npx cdk deploy` from a GitHub-hosted runner. The prod RDS is **private** (VPC-only, no public endpoint), so the runner **cannot** reach it to run `prisma migrate deploy`. Prod migrations are applied **out of band** — a human-gated one-shot bastion (ADR-025 §11, `docs/runbooks/prod-db-migration-verify-apply.md`).

The consequence is structural: **prod code marches forward on every deploy while prod schema only moves when a human remembers to run the bastion.** There is no signal when they diverge. On 2026-07-22 prod was found to be **three migrations behind** (0021/0022/0023 unapplied) — discovered only because a code change happened to depend on a not-yet-present column and 500'd in production. Drift was invisible until it became an outage.

Two gaps: (1) nothing makes drift **observable**; (2) nothing **prevents** shipping code ahead of schema.

## Decision

Three layers, smallest-blast-radius first. Layers 1–2 ship together (Phase 1); layer 3 (Phase 2) follows.

### 1. Migration status is observable (Phase 1)

A build-time **manifest** of the migrations bundled in the release (`scripts/gen-migrations-manifest.mjs` → `src/generated/migrations-manifest.ts`, an ordered list of migration directory names, regenerated on `prisma:generate`) lets the running app know what schema it *expects* without shipping the SQL at runtime.

A dedicated **`GET /api/health/migrations`** endpoint queries `_prisma_migrations` (applied names) and compares to the manifest, returning:

```
{ upToDate, appliedThrough, expectedThrough, appliedCount, expectedCount, pending: [names…] }
```

This is **separate** from the liveness `GET /api/health` (which stays DB-independent so a DB hiccup never fails a liveness/deploy probe). The migrations endpoint is the one that touches the DB.

### 2. The deploy refuses to ship code ahead of schema (Phase 1)

`deploy-prod.yml` gains a **pre-deploy gate**: before `cdk deploy`, it reads prod's currently-applied migration head from the public `GET /api/health/migrations` (no DB access needed from the runner) and compares it to the migrations present in the checkout. **If the checkout contains migrations prod has not applied, the deploy fails** with a pointer to the bastion runbook — you cannot silently ship code past the schema. (This exact gate would have turned the 2026-07-22 incident into a red deploy instead of a prod 500.) A scheduled drift check (a light cron hitting the endpoint) raises the same signal between deploys.

### 3. Gated auto-apply for additive migrations (Phase 2)

To remove the *friction* that causes drift for the safe common case, a dedicated **migrate Lambda** runs inside the prod VPC (bundled schema + migrations, DATABASE_URL from the same secret the app uses) and is **invoked by `deploy-prod.yml` before the web deploy**. It applies **only additive** pending migrations automatically, reusing cortex ADR-128's **migration-guard classifier** (`ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX` / new type/enum → auto; `DROP` / `DELETE` / `TRUNCATE` / `ALTER … TYPE` / `RENAME` → refuse). A **destructive** pending migration makes the Lambda **refuse and fail the deploy**, directing the operator to the human-gated bastion path — so ADR-025 §11's human gate is preserved *exactly where data loss is possible*, and nowhere else.

This mirrors the merge-time policy (additive auto-passes CI; destructive needs a human) at deploy time, closing the gap without weakening the safety property.

## Consequences

- **Drift becomes loud, not latent.** The app reports its own schema currency; the deploy blocks on it; a cron watches between deploys.
- **The human gate narrows to the dangerous case only.** Additive migrations (the overwhelming majority — every one in this repo's history to date) stop requiring a remembered manual step; destructive migrations still require the bastion + human approval.
- **No new standing prod credential in CI.** The migrate Lambda uses the in-VPC DB secret via its execution role; the GitHub runner never gains prod DB reachability. The public health endpoint exposes only migration *names/counts* (no data, no secrets).
- Phase 1 is additive and low-risk (a read-only endpoint + a deploy pre-check). Phase 2 adds a prod infra component (Lambda + IAM + invocation) and is gated on its own review + a `deploy-prod` dry run.

## Alternatives considered

- **Run `prisma migrate deploy` from the GitHub runner** — rejected: requires exposing the private RDS to the runner (public endpoint or a persistent bastion/tunnel), enlarging the attack surface of the prod IdP DB. The in-VPC Lambda keeps DB reachability inside the VPC.
- **Migrate on the app ServerFunction cold start** — rejected: migrations racing across concurrently cold-starting request Lambdas is unsafe (partial/duplicate application, request latency); migration must be a single, ordered, pre-web step.
- **Keep prod fully manual, add visibility only** — this is Phase 1, and it alone prevents the incident class. Phase 2 additionally removes the drift-causing friction; shipping 1 first lets us adopt 3 deliberately.
