# Runbook: verify & apply Engram prod DB migrations

How to inspect the `_prisma_migrations` table on **aws-prod** and apply a pending
migration. Written 2026-07-21 after applying migration `0021` (Tradepost login
tagline) this way; the mechanism is proven end-to-end.

## Why you can't just connect

Engram prod's database is deliberately unreachable from a laptop or a
GitHub-hosted CI runner:

- It is **standard RDS PostgreSQL** (not Aurora) — so there is **no RDS Data
  API**; `aws rds-data execute-statement` does not work against it.
- The instance is `PubliclyAccessible: false` and is reached only through a
  **VPC-internal RDS instance** (`engram-prod-data-postgres9dc8bb04-gqakzxdm5onq.cd6cloglllof.us-west-2.rds.amazonaws.com`). The RDS Proxy that used to front it
  was removed — it cost ~$22/mo to pool a workload peaking at 9 connections.
- Prod is **fully serverless** (OpenNext on Lambda) — there is **no app-host
  EC2 / bastion** in the VPC to tunnel through.
- The `deploy-prod.yml` workflow runs only `prisma:generate`, **not**
  `migrate deploy` (unlike aws-dev / on-prem, which apply migrations in a
  pre-deploy hook). Prod migrations are **human-gated** — ADR-025 §11: *"No
  Prisma migration without Roland approval."*

So both **verifying** and **applying** prod migrations require a one-shot,
VPC-connected shell. The pattern below launches a throwaway EC2 in the prod
private subnet, does the work over SSM, and tears everything down.

## Prod connection facts (verified 2026-07-21)

| Thing | Value |
|---|---|
| VPC | `vpc-0bca04e7d03317cb0` |
| Private-egress subnet (has NAT → SSM works) | `subnet-0507dd4ecb315aab8` (`private-egress`, us-west-2a) |
| Security group (app's; allowed direct to Postgres) | `sg-0237c9db8cab68e40` |
| Postgres host (the instance; there is no longer a proxy) | `engram-prod-data-postgres9dc8bb04-gqakzxdm5onq.cd6cloglllof.us-west-2.rds.amazonaws.com` |
| Port / db / user | `5432` / `engram` / `engram` |
| Admin secret (has the password) | `cortex/prod/engram/db-admin` (`…-sJqeUv`) |
| AWS profile / region | `cortex` / `us-west-2` |

The `db-admin` secret's `host` is the **RDS instance** endpoint — ignore it and
connect to the **instance** host above (the app's SG is allowed direct, not
the instance directly). The dbname is not in the secret; it is `engram` (from
the app Lambda's `DATABASE_URL`). Always `sslmode=require`.

## The one-shot bastion pattern

1. **Create a temporary, scoped IAM role + instance profile** — trust `ec2`,
   attach `AmazonSSMManagedInstanceCore`, and an inline policy granting only
   `secretsmanager:GetSecretValue` on the `db-admin` secret ARN. (The instance
   reads the secret itself, so the DB password never transits SSM command logs.)
2. **Launch a `t3.micro`** (AL2023 x86_64, e.g. the
   `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64` SSM
   parameter) into `subnet-0507dd4ecb315aab8` with `sg-0237c9db8cab68e40` and
   the instance profile. Tag it `purpose=migrate-verify-temp`. Require IMDSv2
   (`--metadata-options HttpTokens=required`).
3. **Wait for SSM** — poll `aws ssm describe-instance-information` until
   `PingStatus=Online` (usually < 30 s; the private-egress NAT gives the SSM
   agent egress).
4. **Run the query/apply over SSM** (`AWS-RunShellScript`): install a psql
   client (`dnf install -y postgresql15 || postgresql16`), read the password
   from the secret, connect to the instance.
5. **Tear everything down** — terminate the instance, then delete the instance
   profile, inline policy, detached managed policy, and role. Use a `trap … EXIT`
   so cleanup runs even on failure.

Total cost ≈ $0.001, ~5–8 minutes (most of it installing Node + Prisma on the
box).

**Use the committed script — don't hand-roll this.** `scripts/prod-db-migrate.sh`
implements the pattern with the ADR-033 fail-closed requirements baked in:

```bash
# 1. Build the bundle from the exact commit you intend to apply, in a clean checkout:
tar czf /tmp/prisma-bundle.tgz prisma/schema.prisma prisma/migrations

# 2. Take a pre-migration snapshot, then ALWAYS dry-run first (read-only, creates nothing):
SNAPSHOT_ID=engram-prod-premigration-<NNNN>-<YYYYMMDD> ./scripts/prod-db-migrate.sh --dry-run

# 3. Only after the dry run is clean:
SNAPSHOT_ID=engram-prod-premigration-<NNNN>-<YYYYMMDD> ./scripts/prod-db-migrate.sh

# 4. NOT OPTIONAL — verify out-of-band. SSM "Success" is not proof (ADR-033 §4):
curl -s https://login.ctxhost.com/api/health/migrations | python3 -m json.tool
```

`dbLatestApplied` must equal the migration you intended to apply. Note
`expectedThrough`/`expectedCount` reflect the **currently deployed app's**
manifest, so right after a migration-ahead-of-code apply the endpoint correctly
reports the DB ahead of the app — `dbLatestApplied` is the field that answers
"did the schema move."

### Why the script looks the way it does (ADR-033)

Three traps, all hit for real on 2026-07-31:

- **Node.** `dnf install -y nodejs` on AL2023 gives **Node 18**; `prisma@7` needs
  `^20.19 || ^22.12 || >=24`. The script installs a **pinned** Node 22 LTS from
  the nodejs.org tarball and asserts the major version before proceeding.
- **`pipefail`.** Every prisma call is piped to `tail` to stay under the SSM
  output cap. Without `set -eo pipefail` the pipeline returns *tail's* status, so
  a failed migration reports SSM `Success`. This produced a **silent no-op**:
  green everywhere, prod still on the old schema.
- **Prisma 7 config.** `schema.prisma`'s datasource has **no `url`** — it comes
  from `prisma.config.ts`. `DATABASE_URL` in the env is *not* a substitute. The
  script synthesizes a minimal `prisma.config.mjs` on the box and installs
  prisma **locally** (not via `npx`) so `import … from "prisma/config"` resolves.

Post-apply `prisma migrate status` is left as a **hard assertion** (it exits
non-zero while anything is pending), while pre-apply status is explicitly
tolerated with `|| true` since pending migrations are the normal starting state.

### Verify without applying

The cheapest verification needs no bastion at all — the public endpoint reads
`_prisma_migrations` through the app's own connection:

```bash
curl -s https://login.ctxhost.com/api/health/migrations | python3 -m json.tool
```

For a raw history read from inside the VPC (rarely needed), the bastion pattern
above with `psql` still works:

```bash
CONN='host=engram-prod-data-postgres9dc8bb04-gqakzxdm5onq.cd6cloglllof.us-west-2.rds.amazonaws.com port=5432 dbname=engram user=engram sslmode=require'
psql "$CONN" -c 'SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name;'
```

### Prefer `migrate deploy` over raw `psql -f`

Historically this runbook applied migrations by piping the migration's SQL
straight into `psql`. **Prefer `prisma migrate deploy`** (what the committed
script does): running SQL directly does **not** insert a `_prisma_migrations`
row, leaving prod permanently "pending" from Prisma's point of view and from
the ADR-032 drift gate's.

If you ever do apply raw SQL, do **not** hand-insert the history row unless you
can reproduce Prisma's exact SHA-256 checksum of the migration file — a wrong
checksum makes every future `migrate deploy` fail with "migration was modified
after applied". A genuinely idempotent migration self-heals on the next real
`migrate deploy`; a schema migration generally will not.

## Guardrails

- **Human-gated.** Applying is a prod write — get explicit approval per ADR-025
  §11 before running the apply path. Verification (read-only) is low-risk but
  still touches prod DB credentials.
- **Always tear down.** The IAM role grants prod-secret read; never leave it or
  the instance behind. Confirm with
  `aws ec2 describe-instances --filters Name=tag:purpose,Values=migrate-verify-temp …`
  and `aws iam get-role --role-name <name>` (should be `NoSuchEntity`).
- **Back up first for anything non-trivial.** Prod has PITR; for schema or
  multi-row changes, take an on-demand snapshot before applying.
- **Dry-run first, always.** `--dry-run` creates nothing and makes only
  read-only calls; it proves the subnet/SG/AMI/secret/snapshot and prints the
  exact migration set that would be applied.
- **A green exit is not a verified migration.** SSM `Success` means a shell
  script exited zero. Confirm `dbLatestApplied` on the health endpoint before
  declaring done or promoting app code (ADR-033 §4).
- **Migration before promotion.** `promote-prod.sh` refuses to ship code
  carrying migrations prod hasn't applied (ADR-032's drift gate). That abort is
  the gate working — apply the migrations, then re-run the promotion.

## Related

- `scripts/prod-db-migrate.sh` — the committed implementation of this runbook.
- ADR-033 — pinned runtime + fail-closed execution (why the script is shaped
  this way; the 2026-07-31 silent no-op).
- ADR-032 — prod migration drift tracking; its Phase 2 in-VPC migrate Lambda
  eventually replaces this bastion.
- `docs/runbooks/prod-promotion.md` — app-code promotion (dispatch-only).
- ADR-025 §11 — prod deploy is dispatch-only and human-executed; migrations
  human-gated.
