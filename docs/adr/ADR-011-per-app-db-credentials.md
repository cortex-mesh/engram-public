# ADR-011 — Per-app database credentials for Engram

**Status:** Proposed
**Date:** 2026-05-06
**Deciders:** Roland Parnaso
**Related:** [pulse ADR-005 §D2-D3](https://github.com/cortex-mesh/pulse/blob/main/docs/adr/ADR-005-aws-deploy.md) — reference per-app credential pattern; [thoughts deployment.md](https://github.com/cortex-mesh/thoughts/blob/main/docs/deployment.md) — same pattern for thoughts; [cortex ADR-066](https://github.com/cortex-mesh/cortex/blob/main/docs/adr/ADR-066-dashboard-auth-and-database-migration.md) — original Postgres consolidation; [cortex ADR-078](https://github.com/cortex-mesh/cortex/blob/main/docs/adr/ADR-078-plexus-db-migrate-to-aws-dev-rds.md) — Plexus follows the same per-app pattern.

## Context

Engram in AWS-dev runs as the `engram` Docker container on `cortex-dev-app-host` EC2, deployed via `/opt/cortex/apps/engram/docker-compose.yml`. It connects to the shared `cortex-dev-data` RDS PostgreSQL instance via a `DATABASE_URL` injected from `/opt/cortex/apps/engram/.env`.

Today, that `DATABASE_URL` uses the **master `cortex` role**:

```
DATABASE_URL=postgresql://cortex:<MASTER_PASSWORD>@cortex-dev-data...:5432/engram?sslmode=no-verify
```

The master credential lives in Secrets Manager as `cortex-dev-data-master`. Per the suite's documented credential model (pulse ADR-005 §D3, thoughts deployment.md), the master is meant to be used **once by an operator** at bootstrap to provision per-app roles and per-app databases — not by running apps in steady state.

**The problem this caused (2026-05-06 incident):** A routine CDK deploy on the cortex repo (cortex#969) caused CloudFormation to replace the master Secrets Manager entry — moving the master password to a freshly-named secret. Pulse, Thoughts, Nexus continued working unaffected because they use per-app roles (`pulse`, `thoughts`, etc.). Engram and Synapse went down because they hold the *master* password in their containers' env, and the rotation invalidated their connections. Engram's logs showed:

```
PrismaClientKnownRequestError: Authentication failed against the database server,
the provided database credentials for `cortex` are not valid
```

Recovery required manually patching `/opt/cortex/apps/engram/.env` with the new master password and restarting the container — a fragile process tied to whoever has SSM access to the EC2 host.

The proper architectural fix: bring Engram in line with the rest of the suite by giving it a dedicated `engram` role + per-app credentials in `engram-dev-runtime` Secrets Manager.

## Decision

Migrate Engram's database access from the master `cortex` role to a dedicated `engram` role following the suite per-app credential pattern.

### D1. Create the `engram` role and grant access to the existing `engram` database

The `engram` logical database already exists on `cortex-dev-data` RDS (created at the original Engram-on-AWS deploy). This ADR adds a per-app role that owns it.

Run **once** by an operator with the master credential:

```sql
CREATE ROLE engram WITH LOGIN PASSWORD '<generated>';
ALTER DATABASE engram OWNER TO engram;
GRANT ALL PRIVILEGES ON DATABASE engram TO engram;
GRANT ALL ON SCHEMA public TO engram;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO engram;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO engram;
```

Notes:
- `<generated>` is a fresh 32-character random password generated at migration time.
- `ALTER DATABASE engram OWNER TO engram` transfers ownership cleanly so `prisma migrate deploy` future runs don't need master.
- Default privileges ensure new tables created by future Prisma migrations are usable by the `engram` role.

### D2. Add `DATABASE_URL` to the `engram-dev-runtime` Secrets Manager entry

The existing `engram-dev-runtime` secret holds Engram's runtime config (JWT secret, OAuth client IDs, ENGRAM_URL, etc.) but **does not** currently include `DATABASE_URL`. Add it:

```json
{
  ...existing keys...,
  "DATABASE_URL": "postgresql://engram:<generated>@cortex-dev-data...:5432/engram?sslmode=no-verify",
  "ENGRAM_DB_USER": "engram",
  "ENGRAM_DB_PASSWORD": "<generated>",
  "ENGRAM_DB_HOST": "cortex-dev-data...",
  "ENGRAM_DB_NAME": "engram"
}
```

`sslmode=no-verify` matches the `pulse-dev-runtime` and `thoughts-dev-runtime` convention.

### D3. Update `/opt/cortex/apps/engram/.env` to read `DATABASE_URL` from the runtime secret

Replace the master-derived line in `.env`:

```diff
-DATABASE_URL=postgresql://cortex:<MASTER>@cortex-dev-data...:5432/engram?sslmode=no-verify
+DATABASE_URL=postgresql://engram:<NEW>@cortex-dev-data...:5432/engram?sslmode=no-verify
```

For now this is an inline copy from Secrets Manager. A future deploy harness can fetch the value at container start (matches the pattern other suite apps will adopt as deploy automation matures).

### D4. Restart the container; verify the login flow

```bash
cd /opt/cortex/apps/engram && sudo docker compose up -d
sleep 10
docker logs --tail 30 engram | grep -iE "error|started"
curl -s https://login.dev.ctxhost.com/api/health   # 200
curl -s "https://login.dev.ctxhost.com/api/auth/continue?redirect_uri=https://dev.ctxhost.com/" -o /dev/null -w "%{http_code}\n"   # 307 (correct)
```

The login flow exercises Prisma's `refreshToken.findFirst()` — the exact path that surfaced the 2026-05-06 incident. Clean logs + 307 on continue confirm recovery.

## Consequences

**Positive**

- Master credential rotations no longer take Engram down.
- Audit-cleaner: the master is only touched by operators at bootstrap; the running container has *exactly* the privileges its workload needs.
- Brings Engram in line with Pulse, Thoughts, Nexus — one credential model across the suite.
- Sets the pattern for future apps (e.g., the upcoming aws-dev Plexus per [cortex ADR-078](https://github.com/cortex-mesh/cortex/blob/main/docs/adr/ADR-078-plexus-db-migrate-to-aws-dev-rds.md)).

**Negative**

- One-time operator effort: provision the role, update the secret, restart the container. Estimated 10-15 minutes during a maintenance window (Engram is briefly down between `down` and `up`).
- Slight coordination cost during the cutover: the container restart invalidates active sessions briefly.

**Neutral**

- The `engram` database itself is untouched (no data migration). Just a permissions / role change.
- Existing `cortexdevdataPostgresSecret-…` (the now-renamed master) keeps working for operator bootstrap of future apps.

## Migration runbook

A one-shot procedure (informally; a more formal `docs/runbooks/per-app-db-credentials-migration.md` can be added later if the same migration is needed elsewhere):

```bash
# 1. Pull master from Secrets Manager
MASTER_PW=$(aws --profile cortex secretsmanager get-secret-value \
  --secret-id cortex-dev-data-master --query SecretString --output text \
  | jq -r .password)
RDS_HOST=cortex-dev-data-postgres9dc8bb04-ovjkci137fcj.cd6cloglllof.us-west-2.rds.amazonaws.com

# 2. Generate per-app password
ENGRAM_PW=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)

# 3. Provision role + own DB
PGPASSWORD="$MASTER_PW" psql -h "$RDS_HOST" -U cortex -d postgres <<SQL
CREATE ROLE engram WITH LOGIN PASSWORD '$ENGRAM_PW';
ALTER DATABASE engram OWNER TO engram;
GRANT ALL PRIVILEGES ON DATABASE engram TO engram;
GRANT ALL ON SCHEMA public TO engram;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO engram;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO engram;
SQL

# 4. Update engram-dev-runtime secret
aws --profile cortex secretsmanager get-secret-value --secret-id engram-dev-runtime --query SecretString --output text \
  | jq --arg url "postgresql://engram:$ENGRAM_PW@$RDS_HOST:5432/engram?sslmode=no-verify" \
       --arg pw "$ENGRAM_PW" \
       --arg host "$RDS_HOST" \
       '. + {DATABASE_URL: $url, ENGRAM_DB_USER: "engram", ENGRAM_DB_PASSWORD: $pw, ENGRAM_DB_HOST: $host, ENGRAM_DB_NAME: "engram"}' \
  | aws --profile cortex secretsmanager put-secret-value --secret-id engram-dev-runtime --secret-string file:///dev/stdin

# 5. Update on-host .env + restart (via SSM)
NEW_URL="postgresql://engram:$ENGRAM_PW@$RDS_HOST:5432/engram?sslmode=no-verify"
aws --profile cortex ssm send-command --instance-ids i-0eaa10f590d4fcd94 \
  --document-name AWS-RunShellScript \
  --parameters "commands=[
    'sudo cp /opt/cortex/apps/engram/.env /opt/cortex/apps/engram/.env.pre-per-app',
    'sudo sed -i \"s|^DATABASE_URL=.*|DATABASE_URL=$NEW_URL|\" /opt/cortex/apps/engram/.env',
    'cd /opt/cortex/apps/engram && sudo docker compose up -d'
  ]"
```

## Rollback

If the per-app role is broken (missing privilege, etc.), revert by:

```bash
ssh-or-ssm cortex-dev-app-host
sudo cp /opt/cortex/apps/engram/.env.pre-per-app /opt/cortex/apps/engram/.env
cd /opt/cortex/apps/engram && sudo docker compose up -d
```

The `engram` role can be left in place (idle) or dropped via `DROP ROLE engram;` after revoking grants.

## Out of scope

- **Synapse migration to per-app credentials.** Same pattern; covered by [synapse ADR-033](https://github.com/cortex-mesh/synapse/blob/main/docs/adr/ADR-033-per-app-db-credentials.md). Independent.
- **Auto-rotation of per-app credentials.** Future work; matches what AWS Secrets Manager Lambda rotation supports.
- **Ownership of the `engram` database (vs. role-only access).** This ADR makes `engram` the owner via `ALTER DATABASE ... OWNER TO`. If a future scenario needs a separate "writes-only" role, that's a refinement.

## Related

- [pulse ADR-005 §D2-D3](https://github.com/cortex-mesh/pulse/blob/main/docs/adr/ADR-005-aws-deploy.md) — the reference pattern this ADR conforms to
- [synapse ADR-033](https://github.com/cortex-mesh/synapse/blob/main/docs/adr/ADR-033-per-app-db-credentials.md) — companion migration for Synapse (same pattern, separate ADR per repo convention)
- [cortex ADR-078](https://github.com/cortex-mesh/cortex/blob/main/docs/adr/ADR-078-plexus-db-migrate-to-aws-dev-rds.md) — Plexus on AWS-dev follows the same pattern
