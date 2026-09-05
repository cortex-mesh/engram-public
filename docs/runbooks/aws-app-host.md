# AWS app host runtime for Engram

This runbook documents how the EC2 app host receives runtime configuration in the initial AWS rollout.

## Scope

- AWS account/profile: `cortex`
- AWS region: `us-west-2`
- App: Engram
- Host role: single EC2 application host
- Database: Amazon RDS PostgreSQL Single-AZ

Authentication migration is out of scope. Engram keeps its existing auth model.

## Runtime configuration contract

The Engram container expects these environment variables:

- `DATABASE_URL`
- `ENGRAM_JWT_SECRET`
- `ENGRAM_URL`
- `ENGRAM_COOKIE_DOMAIN`
- `ENGRAM_INTERNAL_API_KEY`
- `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE`
- `ENGRAM_GOOGLE_CLIENT_ID`
- `ENGRAM_GOOGLE_CLIENT_SECRET`
- `ENGRAM_GITHUB_CLIENT_ID`
- `ENGRAM_GITHUB_CLIENT_SECRET`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `NEXT_PUBLIC_DASHBOARD_URL`
- `NEXT_PUBLIC_SYNAPSE_URL`
- `NEXT_PUBLIC_THOUGHTS_URL`
- `NEXT_PUBLIC_AXON_URL`
- `NEXT_PUBLIC_PULSE_URL`
- `NEXT_PUBLIC_GYRUS_URL`
- `NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING`

The `NEXT_PUBLIC_*_URL` entries are not cosmetic. In production-mode Engram,
an unset app URL removes that app from redirect allowlists and from
`/api/me/app-switcher`; a user may authenticate successfully and still be
redirected out of the app by the shared header. See
`docs/runbooks/hosted-app-login-and-switcher.md`.

The canonical variable names are defined in:
- `.env.example`
- `docker-compose.yml`
- `infra/cdk/templates/engram.env.tpl`

## Source of truth

For the initial AWS rollout:

- infrastructure values come from CDK config
- secrets come from AWS Secrets Manager
- rendered host environment is written to the EC2 host as `.env`

Do not hardcode secrets in:
- AMIs
- Docker images
- `docker-compose.yml`
- CDK source files
- user-data scripts

## Rendering flow

The currently working dev flow is:

1. Shared platform stacks are provisioned first (`cortex-shared-network`, `cortex-dev-data`, `cortex-dev-app-host`, `cortex-dev-dns`).
2. The shared host reads the shared DB secret and the Engram runtime secret from Secrets Manager.
3. A deployment step uploads Engram source as an artifact and the host builds the app image locally.
4. A deployment step renders `infra/cdk/templates/engram.env.tpl` into a host-local `.env` file with a `DATABASE_URL` that targets the runtime's logical database inside the shared environment RDS instance.
5. The host creates the logical database if needed and applies Prisma migrations.
6. `docker compose` on the EC2 host starts the Engram container on the shared `cortex-apps` network.
7. Shared Caddy on the host is reloaded to proxy `login.dev.ctxhost.com` and `platform.dev.ctxhost.com` to the Engram container while tenant hosts are served from `*.dev.ctxhost.com`.

This works today, but the host-side source build is transitional. The preferred follow-up is a repeatable image pipeline (for example ECR) so the host only pulls and runs versioned images.

## Current deployment expectation

On the EC2 host, Engram currently runs from:

- `/opt/cortex/apps/engram/docker-compose.yml`
- `/opt/cortex/apps/engram/.env`
- shared host Caddy config under `/opt/cortex/shared/caddy/`

The shared host model is:

- one EC2 app host for the environment
- one shared Docker network: `cortex-apps`
- one shared Caddy reverse proxy
- one per-app directory under `/opt/cortex/apps/<app>`

Normal Engram deploys should be full-app deploys from a reviewed and merged
`main` commit, not host-side hot patches. The deployment artifact should include
the tracked application source needed to rebuild the runtime image, regenerate
the Prisma client, run `next build`, apply pending Prisma migrations, and restart
the container from that same commit.

Prisma migrations run as an explicit deployment step before the new app
container is started. Routine migrations must be additive: create tables,
columns, indexes, constraints, or backfill-safe data that does not delete,
rename, or rewrite existing durable data. Any destructive schema change requires
a separate reviewed rollout plan with a backup/restore point and cannot be
hidden inside a normal app deploy.

Example operator flow:

```bash
export AWS_PROFILE=cortex
export AWS_REGION=us-west-2

aws ssm start-session --target <instance-id>
cd /opt/cortex/apps/engram
ls -la
cat .env

docker compose ps
curl http://localhost:3104/api/health

cd /opt/cortex/shared/caddy
docker compose ps
```

## Notes on current cleanup

The pre-AWS on-prem-specific assumptions have been removed from the container contract:

- no `host.docker.internal`
- no inline hardcoded `DATABASE_URL`
- no mismatched `INTERNAL_API_KEY` name

Use `ENGRAM_INTERNAL_API_KEY` consistently.

## Cookie/domain expectation

For the hosted suite on `ctxhost.com`:

- `ENGRAM_URL=https://login.ctxhost.com`
- `ENGRAM_COOKIE_DOMAIN=.ctxhost.com`

For local development:

- `ENGRAM_COOKIE_DOMAIN=` (unset / empty)
- `ENGRAM_URL=http://localhost:3104`

## Verification checklist

- `.env.example` matches the actual runtime contract
- `docker-compose.yml` consumes the same names the application code expects
- `DATABASE_URL` points at RDS, not localhost or `host.docker.internal`
- no secrets embedded in user data
- no secrets embedded in committed templates beyond placeholders
