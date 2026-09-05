# CDK Deploy Runbook

This runbook covers deployment-readiness for the hosted ctxhost AWS rollout, with shared platform stacks now sourced from `cortex/infra/cdk` and Engram remaining responsible for app-specific runtime deployment.

> 2026-07-13 ownership note: Tradepost's app-scoped CDK stacks are the current
> precedent. Shared platform stacks (network, data, app-host, DNS) are
> Cortex-owned. App repos own app-specific stacks and runtime/deploy details.
> Any remaining shared-platform copy under Engram's historical `infra/cdk`
> should be treated as retirement drift, not as the canonical source of truth.

## AWS target

- AWS profile: `cortex`
- AWS region: `us-west-2`
- Account: `782369544445`

## Current readiness notes

- CDK bootstrap stack exists in `us-west-2`
- Current bootstrap version has been refreshed successfully for this rollout
- Route 53 hosted zone exists for `ctxhost.com`
- Namecheap delegation to Route 53 is confirmed live; public resolvers now return the AWS nameservers for `ctxhost.com`
- Current infra code defaults to the lean environment model:
  - shared network stack (`cortex-shared-network`)
  - environment DNS stacks (`cortex-dev-dns`, `cortex-prod-dns`)
  - shared environment data stacks (`cortex-dev-data`, `cortex-prod-data`)
  - app-specific runtime stacks such as `cortex-dev-app-host`, `cortex-prod-app-host`, or future personal stacks like `engram-roland-app`
- Current source-of-truth split:
  - shared Cortex-owned stacks are deployed from `cortex/infra/cdk`
  - Engram keeps app-specific runtime docs/assets under `engram/docs` and `engram/infra/cdk/templates`

Before the first production deploy, resolve these:
1. keep `DEPLOY_ENV=dev` for the first hosted validation deploy
2. reserve `DEPLOY_ENV=prod` for the production rollout after dev is verified end-to-end

## Required environment

```bash
export AWS_PROFILE=cortex
export AWS_REGION=us-west-2
```

Optional configuration overrides:

```bash
export ROOT_DOMAIN=ctxhost.com
export HOSTED_ZONE_ID=Z099959326CYRBW3F5PTA
export DEPLOY_ENV=dev
export INSTANCE_TYPE=t4g.medium
export APP_VOLUME_SIZE_GIB=50
export DB_INSTANCE_CLASS=db.t4g.small
export DB_ALLOCATED_STORAGE_GIB=20
export DB_BACKUP_RETENTION_DAYS=7
export DB_MULTI_AZ=false
```

## Install and verify

From the workspace root, verify the shared platform CDK package:

```bash
cd cortex/infra/cdk
npm install
npm test
npm run build
npm run cdk:synth
```

## Inspect diffs

Network only:

```bash
AWS_PROFILE=cortex AWS_REGION=us-west-2 \
  npx cdk diff cortex-shared-network --app 'npx tsx bin/cortex-platform.ts'
```

Full app/data/network:

```bash
AWS_PROFILE=cortex AWS_REGION=us-west-2 \
  npx cdk diff --app 'npx tsx bin/cortex-platform.ts'
```

With DNS enabled:

```bash
AWS_PROFILE=cortex AWS_REGION=us-west-2 HOSTED_ZONE_ID=<zone-id> \
  npx cdk diff --app 'npx tsx bin/cortex-platform.ts'
```

## Deploy

Deploy foundational stacks first for dev:

```bash
AWS_PROFILE=cortex AWS_REGION=us-west-2 DEPLOY_ENV=dev \
  npx cdk deploy cortex-shared-network cortex-dev-data cortex-dev-app-host \
  --app 'npx tsx bin/cortex-platform.ts'
```

For personal Engram runtimes, deploy the shared environment data stack once, then deploy an app-specific runtime stack such as `engram-roland-app` or `engram-ryan-app` that points at its own logical database inside `cortex-dev-data`.

After nameserver delegation is live:

```bash
AWS_PROFILE=cortex AWS_REGION=us-west-2 DEPLOY_ENV=dev HOSTED_ZONE_ID=Z099959326CYRBW3F5PTA \
  npx cdk deploy cortex-dev-dns \
  --app 'npx tsx bin/cortex-platform.ts'
```

Or deploy all stacks for the current environment together:

```bash
AWS_PROFILE=cortex AWS_REGION=us-west-2 DEPLOY_ENV=dev HOSTED_ZONE_ID=Z099959326CYRBW3F5PTA \
  npx cdk deploy --all --app 'npx tsx bin/cortex-platform.ts'
```

## Post-deploy checks

- confirm EC2 instance exists
- confirm RDS instance is available
- confirm DB secret exists in Secrets Manager
- confirm EIP is allocated and attached
- confirm DNS records exist once `HOSTED_ZONE_ID` is supplied
- confirm the deployed runtime points at the intended logical database inside the shared environment RDS instance

Useful commands:

```bash
aws cloudformation list-stacks --region us-west-2 --output table
aws ec2 describe-instances --region us-west-2 --output table
aws rds describe-db-instances --region us-west-2 --output table
aws secretsmanager list-secrets --region us-west-2 --output table
```

## Current blockers

- use `DEPLOY_ENV=dev` for ongoing hosted validation work; reserve `DEPLOY_ENV=prod` for the production rollout
- shared platform infra is now deployed in AWS dev, but app-runtime rollout and end-to-end tenant workflow verification still need to continue on top of that base

## Recommendation

Use `DEPLOY_ENV=dev` for ongoing hosted validation. The shared network, shared dev data plane, shared dev app host, and `cortex-dev-dns` are now deployed from `cortex/infra/cdk`, and the legacy `cortex-shared-dns` stack has been removed so prod-looking root-domain records no longer point at the dev runtime. Continue deploying and verifying app-specific services and personal runtimes such as `engram-roland-app`, each targeting its own logical database inside `cortex-dev-data`. Promote to `DEPLOY_ENV=prod` only after the dev environment is verified end-to-end.
