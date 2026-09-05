# AWS CDK Infrastructure Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Provision the initial `ctxhost.com` AWS footprint with CDK: app-specific EC2 runtimes, a shared environment-level RDS PostgreSQL data plane, Route 53 DNS, and secure connectivity back to the local CORTEX fleet, while documenting that shared Cortex stacks will later move to `cortex/infra/cdk`.

**Architecture:** A TypeScript CDK app in the Engram repo provisions four logical stack families: shared network, shared DNS, environment-scoped shared data, and app-specific runtimes. The app tier runs on EC2 with Docker/Caddy, durable relational data lives in one private RDS PostgreSQL Single-AZ instance per environment, and each app runtime creates or uses its own logical database inside that shared environment data plane while Redis-backed orchestration remains local over Tailscale. The current repo location is transitional: shared Cortex-owned stacks stay here for the first rollout, then move to `cortex/infra/cdk` after the design and deploy flow stabilize.
**Tech Stack:** AWS CDK v2, TypeScript, Node.js 22, EC2, RDS PostgreSQL, Route 53, Secrets Manager, SSM, Docker Compose, Tailscale

---

### Task 1: Create the infrastructure directory skeleton

**Objective:** Add a dedicated CDK workspace under `infra/cdk/` without polluting the existing app runtime files, while documenting that shared Cortex-owned stacks will later move into `cortex/infra/cdk`.

**Files:**
- Create: `engram/infra/cdk/package.json`
- Create: `engram/infra/cdk/tsconfig.json`
- Create: `engram/infra/cdk/cdk.json`
- Create: `engram/infra/cdk/bin/engram-infra.ts`
- Create: `engram/infra/cdk/lib/`
- Modify: `engram/docs/adr/ADR-004-initial-aws-infrastructure-with-cdk.md` (only if implementation path needs a minor clarification)

**Step 1: Write the plan-local acceptance checklist**

Define the expected generated files and commands in the new directory:
- `npm install`
- `npm run build`
- `npx cdk synth`

**Step 2: Add the minimal CDK package manifest**

Create `engram/infra/cdk/package.json` with scripts like:
- `build`
- `typecheck`
- `cdk:synth`
- `cdk:diff`
- `cdk:deploy`

Dependencies should include:
- `aws-cdk-lib`
- `constructs`
- `typescript`
- `tsx` or `ts-node`
- `@types/node`

**Step 3: Add TypeScript and CDK config**

Create:
- `engram/infra/cdk/tsconfig.json`
- `engram/infra/cdk/cdk.json`

Keep them boring and explicit. Do not invent a monorepo build system.

**Step 4: Add the CDK entrypoint**

Create `engram/infra/cdk/bin/engram-infra.ts` that:
- reads environment config
- instantiates the stacks in order
- passes shared references between them

**Step 5: Verify**

Run:
```bash
cd engram/infra/cdk
npm install
npm run build
npx cdk synth
```

Expected:
- TypeScript compiles
- CDK synthesizes even if some context values are placeholder/dev values

**Step 6: Commit**

```bash
git add engram/infra/cdk
git commit -m "docs: scaffold CDK infrastructure workspace"
```

---

### Task 2: Define typed infrastructure configuration

**Objective:** Create a single typed source of truth for region, domain, instance size, DB size, naming, and the distinction between shared environment data stacks and app-specific runtime stacks.

**Files:**
- Create: `engram/infra/cdk/lib/config.ts`
- Create: `engram/infra/cdk/lib/types.ts`
- Test: `engram/infra/cdk/lib/config.test.ts` or `engram/infra/cdk/test/config.test.ts`

**Step 1: Write a failing test**

Add tests for configuration parsing and defaults:
- default AWS CLI profile is `cortex`
- default region is `us-west-2`
- default root domain is `ctxhost.com`
- default instance type is `t4g.medium`
- default DB class is `db.t4g.small`
- default DB multi-AZ is `false`

**Step 2: Run the test to verify failure**

Run:
```bash
cd engram/infra/cdk
npm test -- --runInBand
```
or whatever test runner you choose for the infra package.

Expected: fail because config module does not exist yet.

**Step 3: Implement the typed config module**

Create a small config shape that includes:
- AWS region
- hosted zone/domain
- deployment environment (`dev` or `prod`)
- shared stack naming helpers for `cortex-shared-network`, `cortex-<env>-dns`, and `cortex-<env>-data`
- app-runtime naming helpers for stacks like `cortex-dev-app-host`, `cortex-prod-app-host`, and future personal runtimes such as `engram-roland-app`
- EC2 instance type
- EBS size
- RDS instance class
- RDS allocated storage
- RDS Multi-AZ boolean
- SSH allowed CIDR or disabled flag
- Tailscale auth / bootstrap strategy flag

**Step 4: Re-run tests**

Expected: pass.

**Step 5: Commit**

```bash
git add engram/infra/cdk/lib
git commit -m "feat: add typed infrastructure config"
```

---

### Task 3: Implement the network stack

**Objective:** Provision the minimal VPC topology needed for public EC2 and private RDS without NAT Gateway.

**Files:**
- Create: `engram/infra/cdk/lib/network-stack.ts`
- Test: `engram/infra/cdk/test/network-stack.test.ts`

**Step 1: Write failing tests**

Assert synthesized output includes:
- one VPC
- public subnets for EC2
- private subnets for RDS
- no NAT Gateway
- security groups exported for app and database tiers

**Step 2: Run the test to verify failure**

Run the infra test command.

Expected: fail because `network-stack.ts` does not exist.

**Step 3: Implement the stack**

Provision:
- VPC
- 2 public subnets
- 2 private isolated subnets
- app security group
- DB security group

Rules:
- app SG allows 80/443 inbound
- DB SG only allows PostgreSQL from app SG
- do not create public DB access
- do not add NAT Gateway initially

**Step 4: Verify synth output**

Run:
```bash
cd engram/infra/cdk
npx cdk synth
```

Expected:
- VPC and subnet resources present
- no NAT Gateway resources

**Step 5: Commit**

```bash
git add engram/infra/cdk/lib/network-stack.ts engram/infra/cdk/test/network-stack.test.ts
git commit -m "feat: add network stack for EC2 and private RDS"
```

---

### Task 4: Implement the shared environment data stack for RDS PostgreSQL Single-AZ

**Objective:** Provision the shared environment-level managed relational data plane with secure defaults.

**Files:**
- Create: `engram/infra/cdk/lib/data-stack.ts`
- Test: `engram/infra/cdk/test/data-stack.test.ts`

**Step 1: Write failing tests**

Assert synthesized output includes:
- PostgreSQL engine
- instance class `db.t4g.small` by default
- `MultiAZ: false`
- storage encryption enabled
- private subnet placement
- generated secret or referenced secret for the shared environment RDS instance
- backups enabled
- no assumption that the stack creates only one hardcoded application database such as `engram`

**Step 2: Run the test to verify failure**

Expected: fail because `data-stack.ts` does not exist.

**Step 3: Implement the stack**

Provision:
- RDS PostgreSQL Single-AZ
- subnet group using private isolated subnets
- credentials in Secrets Manager for provisioning/admin access to the shared environment instance
- backup retention
- deletion protection configurable by environment
- security-group attachment from network stack

Do not add Aurora.
Do not add public accessibility.
Do not hardcode a single app database name into the infrastructure stack.
Logical databases like `engram`, `engram_roland`, or `engram_ryan` should be created by deployment/bootstrap automation or app-level provisioning, not by making the data stack represent a single app database.

**Step 4: Verify synth output**

Run:
```bash
cd engram/infra/cdk
npx cdk synth
```

Expected:
- DB instance synthesized with `MultiAZ: false`
- no public DB endpoint

**Step 5: Commit**

```bash
git add engram/infra/cdk/lib/data-stack.ts engram/infra/cdk/test/data-stack.test.ts
git commit -m "feat: add single-az rds postgres data stack"
```

---

### Task 5: Implement the EC2 app stack

**Objective:** Provision an app-specific single-host runtime that runs Docker/Caddy and the app containers.

**Files:**
- Create: `engram/infra/cdk/lib/app-stack.ts`
- Create: `engram/infra/cdk/assets/user-data/bootstrap.sh`
- Test: `engram/infra/cdk/test/app-stack.test.ts`

**Step 1: Write failing tests**

Assert synthesized output includes:
- one EC2 instance
- ARM instance type `t4g.medium` by default
- attached instance profile with SSM permissions
- EBS gp3 volume sizing
- security group for 80/443
- user data present

**Step 2: Run the test to verify failure**

Expected: fail because `app-stack.ts` does not exist.

**Step 3: Implement the stack**

Provision:
- EC2 instance
- IAM role/profile with SSM core permissions
- EBS root or attached gp3 volume
- app security group from network stack
- user data to install:
  - Docker
  - Docker Compose plugin
  - Caddy or your chosen reverse proxy
  - Tailscale client

Do not encode secrets directly in user data.

**Step 4: Keep application bootstrap minimal**

`bootstrap.sh` should prepare the host, not fully deploy app code. Keep app deployment separate from infrastructure provisioning.

It should also leave room for per-runtime database provisioning such as creating `engram_roland` or `engram_ryan` inside the shared environment RDS instance before running migrations.

**Step 5: Verify**

Run:
```bash
cd engram/infra/cdk
npx cdk synth
```

Expected:
- EC2 resources synthesize cleanly
- no secret values in plain text in the template

**Step 6: Commit**

```bash
git add engram/infra/cdk/lib/app-stack.ts engram/infra/cdk/assets/user-data/bootstrap.sh engram/infra/cdk/test/app-stack.test.ts
git commit -m "feat: add ec2 application stack"
```

---

### Task 6: Implement the DNS stack for `ctxhost.com`

**Objective:** Provision Route 53 records for Engram and tenant routing.

**Files:**
- Create: `engram/infra/cdk/lib/dns-stack.ts`
- Test: `engram/infra/cdk/test/dns-stack.test.ts`

**Step 1: Write failing tests**

Assert synthesized output includes records for:
- `login.ctxhost.com`
- wildcard or explicit tenant routing for `*.ctxhost.com`

**Step 2: Run test to verify failure**

Expected: fail because `dns-stack.ts` does not exist.

**Step 3: Implement the stack**

Start simple:
- `login.ctxhost.com`
- wildcard `*.ctxhost.com` or explicit records if preferred initially

Point them at the EC2 public endpoint or Elastic IP.

**Step 4: Verify**

Run:
```bash
cd engram/infra/cdk
npx cdk synth
```

Expected:
- DNS records present
- no assumptions about ALB

**Step 5: Commit**

```bash
git add engram/infra/cdk/lib/dns-stack.ts engram/infra/cdk/test/dns-stack.test.ts
git commit -m "feat: add route53 dns stack for ctxhost"
```

---

### Task 7: Add stack wiring and outputs

**Objective:** Connect the stacks together cleanly and expose the outputs operators need.

**Files:**
- Modify: `engram/infra/cdk/bin/engram-infra.ts`
- Create: `engram/infra/cdk/lib/outputs.ts`
- Test: `engram/infra/cdk/test/stack-wiring.test.ts`

**Step 1: Write a failing integration-style synth test**

Assert:
- app stack consumes network outputs
- data stack uses DB SG and private subnets
- DNS points at the app tier

**Step 2: Implement wiring**

Pass references explicitly:
- VPC and SGs from network → data/app
- EC2 endpoint/IP from app → DNS
- shared RDS endpoint/secret from data → app outputs and runtime provisioning steps
- app runtime database name/input from app deployment context → rendered `DATABASE_URL`
**Step 3: Add operator-friendly outputs**

Output:
- EC2 instance ID
- public IP / Elastic IP if used
- RDS endpoint
- secret ARN
- hosted zone name

**Step 4: Verify**

Run:
```bash
cd engram/infra/cdk
npx cdk synth
npm run typecheck
```

Expected: no type errors, stacks synthesize together.

**Step 5: Commit**

```bash
git add engram/infra/cdk/bin/engram-infra.ts engram/infra/cdk/lib/outputs.ts engram/infra/cdk/test/stack-wiring.test.ts
git commit -m "feat: wire cdk stacks and outputs"
```

---

### Task 8: Define host runtime configuration and secret contract

**Objective:** Make the EC2 host and app containers consume RDS and app secrets cleanly.

**Files:**
- Create: `engram/infra/cdk/templates/engram.env.tpl`
- Create: `engram/infra/cdk/templates/caddy/Caddyfile.tpl`
- Modify: `engram/.env.example`
- Modify: `engram/docker-compose.yml`
- Create: `engram/docs/runbooks/aws-app-host.md`

**Step 1: Write failing checks**

Search for mismatches between expected AWS env vars and current local/on-prem assumptions.

Examples to fix:
- `DATABASE_URL` currently assumes localhost/host.docker.internal paths
- `.env.example` is malformed and needs cleanup before AWS deployment work

**Step 2: Implement the template contract**

Define host/app env expectations such as:
- `DATABASE_URL`
- `ENGRAM_URL`
- `ENGRAM_COOKIE_DOMAIN`
- OAuth secrets
- Resend key
- Tailscale auth/bootstrap vars if used

**Step 3: Normalize the existing `.env.example`**

Fix current broken lines and make the file production-readable.

**Step 4: Document how runtime config is rendered onto the EC2 host**

Do not hand-wave this. State exactly whether values come from:
- Secrets Manager
- SSM Parameter Store
- manually provisioned `.env`

**Step 5: Verify**

Run:
```bash
cd engram
npm run typecheck
npm run lint
```

Expected: current app still passes after env/example and compose changes.

**Step 6: Commit**

```bash
git add engram/.env.example engram/docker-compose.yml engram/infra/cdk/templates engram/docs/runbooks/aws-app-host.md
git commit -m "docs: define aws host runtime configuration"
```

---

### Task 9: Document secure AWS ↔ local CORTEX connectivity

**Objective:** Make the hybrid-cloud boundary explicit and operable.

**Files:**
- Create: `engram/docs/runbooks/aws-local-cortex-connectivity.md`
- Optionally create: `engram/infra/cdk/lib/connectivity-notes.md` (only if you want infra-local docs)

**Step 1: Document the connectivity contract**

Include:
- EC2 joins Tailscale
- which local services are reachable
- which service names / IPs the AWS apps use
- what remains local:
  - conductor
  - Redis bus
  - agents

**Step 2: Document failure handling**

Specify what happens if the private connectivity layer is down:
- app behavior
- degraded mode expectations
- health checks to run

**Step 3: Verify docs quality**

Check that the document does not imply public exposure of local services.

**Step 4: Commit**

```bash
git add engram/docs/runbooks/aws-local-cortex-connectivity.md
git commit -m "docs: add aws to local cortex connectivity runbook"
```

---

### Task 10: Add deployment and verification commands

**Objective:** Make initial deployment reproducible for a human operator.

**Files:**
- Create: `engram/docs/runbooks/cdk-deploy.md`
- Modify: `engram/docs/adr/README.md` only if links are helpful
- Modify: `engram/docs/plans/2026-04-20-aws-cdk-infrastructure.md` only if you need to append learned notes after implementation

**Step 1: Document exact commands**

Include:
```bash
export AWS_PROFILE=cortex
export AWS_REGION=us-west-2

cd engram/infra/cdk
npm install
npm run build
npx cdk synth
npx cdk diff
npx cdk deploy
```

And for app verification:
```bash
aws ssm start-session --target <instance-id>
curl -I https://login.ctxhost.com
curl -I https://cortex.ctxhost.com
```

**Step 2: Add verification checklist**

The checklist should confirm:
- EC2 reachable
- RDS private and healthy
- app can connect to RDS
- `login.ctxhost.com` resolves correctly
- wildcard tenant routing works
- Tailscale/private connectivity to local CORTEX works

**Step 3: Verify plan completeness**

Run one final review of the plan and make sure every major artifact has an exact path.

**Step 4: Commit**

```bash
git add engram/docs/runbooks/cdk-deploy.md engram/docs/plans/2026-04-20-aws-cdk-infrastructure.md
git commit -m "docs: add cdk deployment runbook"
```

---

## Hosted Application Rollout Order

1. **Engram first** — establish `login.ctxhost.com`, RDS connectivity, cookie/domain behavior, and the hosted auth boundary.
2. **Nexus second** — build and deploy Nexus as the first tenant-root workspace shell on the shared host, sitting behind Engram’s hosted identity boundary.
3. **Dashboard after Nexus** — keep Dashboard in the `cortex` repo, but position it as the internal operator console rather than the tenant workspace shell.
4. **Synapse next** — move after Engram and Nexus so chat-specific auth and tenant routing are validated against the stable hosted identity layer.
5. **Thoughts after Synapse** — move after the auth boundary and workspace/navigation patterns are already proven.

Do not split Dashboard out of the `cortex` repo during this migration. Repo extraction, if still desirable later, is a post-migration decision.

## Final Verification Checklist

- [ ] `engram/infra/cdk/` exists with a working CDK app
- [ ] `npm run build` passes in `engram/infra/cdk`
- [ ] `npx cdk synth` passes
- [ ] Network stack creates public EC2 + private RDS topology with no NAT Gateway
- [ ] Data stack provisions RDS PostgreSQL Single-AZ, private only, encrypted, backed up
- [ ] App stack provisions one EC2 host with SSM and bootstrap user data
- [ ] DNS stack provisions `login.ctxhost.com` and tenant routing records
- [ ] `.env.example` is cleaned up and no longer malformed
- [ ] App runtime config explains how secrets reach the EC2 host
- [ ] AWS ↔ local CORTEX private connectivity is documented and tested
- [ ] `engram` app still passes `npm run typecheck` and `npm run lint`

## Notes for Execution

- Keep the first deployment intentionally simple.
- Authentication migration is out of scope for this phase: keep Engram's current auth architecture and do not introduce Cognito work into the initial AWS rollout.
- Do not sneak in ALB, NAT Gateway, ECS, EKS, Aurora, or ElastiCache unless the user explicitly changes the constraint.
- Keep Redis orchestration local until the conductor/agents move.
- Do not put PostgreSQL on EC2.
- Use TDD for any code changes in the CDK workspace and app configuration files.
