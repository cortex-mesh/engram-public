# ADR-033: Prod migration bastion — pinned runtime + fail-closed execution

**Status:** Accepted (2026-07-31)

**Relates to:** ADR-025 §11 (prod migrations are human-gated) · ADR-032 (prod migration drift tracking; its Phase 2 migrate Lambda eventually replaces this bastion) · `docs/runbooks/prod-db-migration-verify-apply.md`. Motivated by the 2026-07-31 silent no-op described below.

## Context

Until ADR-032 Phase 2 (the in-VPC migrate Lambda) ships, the **one-shot bastion** is the only mechanism that applies migrations to aws-prod: a throwaway `t3.micro` launched into the prod private subnet, driven over SSM, torn down by `trap … EXIT`.

On 2026-07-31, applying migrations `0026`/`0027` through that bastion **reported success and applied nothing**. The SSM command returned `Status: Success`, teardown was clean, and the operator had every surface-level reason to believe prod was migrated. It was not — `dbLatestApplied` was still `0025`. The gap was caught only because the public `/api/health/migrations` endpoint (ADR-032 Phase 1) was checked independently afterward.

Two independent defects combined to produce a false green:

1. **The AMI's Node is too old for the tool.** The bastion ran `dnf install -y nodejs`, which on Amazon Linux 2023 installs **Node 18**. `prisma@7.8.0` requires `^20.19 || ^22.12 || >=24`. Prisma refused to run and emitted no migration output at all — only `npm warn EBADENGINE` lines. The runtime was never asserted, so nothing noticed.

2. **`set -e` was defeated by a pipe.** Every prisma invocation was shaped `npx … migrate deploy 2>&1 | tail -30`. Without `pipefail`, a pipeline's exit status is the **last** command's — `tail`, which always succeeds. Prisma's non-zero exit was discarded, the remote script ran to completion, and SSM recorded `Success`.

Either defect alone is recoverable; together they are worse than a failure, because a silent no-op on a prod schema write invites the *next* step (promoting app code) to proceed against a schema that never moved. ADR-032 exists precisely because code marching ahead of schema caused a prod outage on 2026-07-22. A bastion that lies about applying migrations re-opens that incident class from the other end.

The deeper problem is that **`Status: Success` from SSM was treated as evidence of migration.** It is evidence that a shell script exited zero — nothing more.

A third defect — Prisma 7's config-file requirement (§5) — was only *discoverable* after the first two were fixed, because until prisma actually ran there was no error to see. That ordering is the point: the silent-success shape hides every subsequent bug behind the first one.

## Decision

Six requirements for any prod migration executed through the bastion. They are cheap, and requirements 1–4 each independently would have caught the 2026-07-31 no-op.

### 1. Pin the Node runtime explicitly; never inherit the AMI's

The remote script installs a **pinned** Node version from the official nodejs.org tarball and puts it first on `PATH`. It does **not** use `dnf install nodejs`.

The pin is **Node 22 LTS**, matching both the `Node.js 22 LTS` row in this repo's documented tech stack and `deploy-prod.yml`'s `node-version: 22`, so the bastion introduces no runtime divergence from the deploy pipeline. Moving the fleet to Node 24 (Krypton, the newest LTS line) is a deliberate cross-app upgrade, **not** something to acquire as a side effect of a production migration.

The version is pinned as a literal, not resolved at runtime from a `latest-*` URL — a prod-mutating run must be reproducible, and "whatever was newest that afternoon" is not.

Immediately after install, the script **asserts** the running major version and exits non-zero if it is below Prisma's floor. An unsupported runtime must fail loudly at the top, not silently mid-run.

### 2. The remote script is `set -eo pipefail`

`pipefail` is not optional. Any `cmd | tail -N` (used to keep SSM output under the `get-command-invocation` response cap) otherwise converts a hard failure into a silent success. With `pipefail`, the tails stay — they just can no longer lie.

### 3. Migration status is a hard assertion, not a printout

`prisma migrate status` exits **1** when migrations are pending. That exit code is the check:

- **PRE**-apply status is expected to be non-zero (migrations are pending — that's why we're here) and is explicitly tolerated with `|| true`.
- **POST**-apply status is **not** tolerated. Under `set -e` its zero exit is a machine-checked assertion that nothing remains pending. If migrations did not apply, the remote script fails and SSM reports `Failed`.

This is what converts the bastion from "ran some commands" to "proved the schema moved."

### 4. SSM `Success` is not proof — verify out-of-band

After every apply, confirm against the public `GET /api/health/migrations` endpoint on the target environment before declaring the migration done or proceeding to a code promotion. That endpoint reads `_prisma_migrations` from the app's own connection: it is independent of the bastion, the SSM transcript, and the script's own opinion of itself.

Concretely: `dbLatestApplied` must equal the migration you intended to apply. Note that `expectedThrough`/`expectedCount` reflect the **currently deployed app's** bundled manifest, so immediately after a migration-ahead-of-code apply the endpoint legitimately reports the DB ahead of the app; `dbLatestApplied` is the field that answers "did the schema move."

### 5. Supply Prisma 7's config file — `DATABASE_URL` alone is not enough

Once the runtime was fixed and prisma actually ran, it failed with `The datasource.url property is required in your Prisma config file`. This is a **Prisma 7** behavior change: `engram`'s `prisma/schema.prisma` declares `datasource db { provider = "postgresql" }` with **no `url`**, because the URL is supplied by `prisma.config.ts`. Exporting `DATABASE_URL` in the environment does not substitute for it.

The bundle deliberately ships only `prisma/schema.prisma` + `prisma/migrations` — it does **not** ship the repo's `prisma.config.ts`, which imports `dotenv` and would drag in dependency resolution the bastion has no reason to satisfy. So the bastion **synthesizes a minimal config** on the box (`schema`, `migrations.path`, and `datasource.url` from the environment) and runs prisma against it.

This requires prisma to be **installed locally** (`npm install prisma@<ver>` in the work dir) rather than invoked through `npx`: the config file does `import { defineConfig } from "prisma/config"`, and npx's temporary cache directory is not on the module-resolution path from the work directory.

Note this is exactly the class of drift that requirement 4 exists to catch — it produced a clean, loud failure precisely because requirements 2 and 3 were already in place. Under the original script it would have been a third way to report `Success` while applying nothing.

### 6. `--dry-run` is mandatory before any apply

The script must support `--dry-run` and it must be run first. The dry run performs **only read-only** calls and exits before any resource is created: it prints what would be created, resolves and names the target subnet/SG/AMI, confirms the admin secret is readable and has a `password` key, confirms the temp role name is free and no stale `migrate-verify-temp` instances exist, confirms the pre-migration snapshot exists, prints the pinned Node version and checks the tarball is reachable, and prints the **exact** set of migrations that would be applied against the environment's current head.

## Consequences

- **A no-op apply is now impossible to mistake for a success.** The runtime assertion fails closed, `pipefail` propagates prisma's exit, and the POST-status gate requires an empty pending set. Three independent failure surfaces replaced one silent one.
- **The bastion is reproducible.** A pinned Node version means a rerun months later behaves identically rather than inheriting whatever the AMI or the `latest` channel drifted to.
- **Operators are told, in writing, not to trust SSM's status.** The out-of-band health check is now part of the procedure rather than something a careful operator happens to do.
- **This ADR is deliberately scoped to the interim mechanism.** ADR-032 Phase 2 replaces the bastion with an in-VPC migrate Lambda; when it ships, requirements 2–4 carry over to it unchanged (fail-closed execution, status as assertion, out-of-band verification). Requirement 1 becomes moot — a Lambda's runtime is declared, not inherited from an AMI. This ADR should be marked superseded at that point, not deleted: the failure modes it records are properties of the problem, not of the bastion.
- Cost and blast radius are unchanged: still ~$0.001 and ~3 minutes, still a scoped single-secret IAM role, still torn down with absence proof.

## Alternatives considered

- **Keep `dnf install nodejs` and pin the AMI instead.** Rejected: it couples the Node version to Amazon's AL2023 package set, which moves on its own schedule and is not visible in this repo. Pinning the tool directly is both more explicit and independent of the base image.
- **Drop the `| tail -N` and capture full output.** Rejected as the primary fix: `get-command-invocation` caps returned output, so unbounded output risks truncating the *interesting* tail. `pipefail` fixes the actual defect — the tails were never the problem, the swallowed exit code was.
- **Parse the SSM stdout for a success string.** Rejected: string-matching a tool's human-readable output is brittle and would itself have passed on 2026-07-31 had the string been chosen loosely. Exit codes and an independent endpoint are checkable facts.
- **Ship ADR-032 Phase 2 now instead of hardening the bastion.** Rejected as sequencing: the Lambda is a new prod infra component needing its own review and dry run, and migrations were needed on a known schedule. Hardening the existing path is hours of work; it also produces the invariants Phase 2 must satisfy anyway.
