# ADR-004: Initial AWS Infrastructure with CDK

**Status:** Proposed
**Date:** 2026-04-20
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-003 (Tenant Workspace Domains and Product Routing), Synapse ADR-014 (Organizations and Multi-Tenancy)

## Context

ADR-003 established the initial hosted deployment posture for `ctxhost.com`:

- the application tier runs on AWS
- the initial public app tier is a single EC2-backed host with a reverse proxy and app containers
- the primary relational database runs on Amazon RDS PostgreSQL in Single-AZ mode
- Redis-backed orchestration remains with the local CORTEX fleet while the conductor and agents stay local

The next decision is how to define and provision that AWS infrastructure.

The infrastructure needs to support:

- Engram at `login.ctxhost.com`
- tenant workspace roots like `<org>.ctxhost.com`
- product paths under tenant domains such as `/synapse`, `/thoughts`, and future `/pulse`
- managed PostgreSQL for PII-sensitive data
- secure connectivity from AWS-hosted apps back to the local CORTEX conductor and agents
- an implementation approach that is maintainable by a TypeScript-heavy product team
- an initial monthly cost target around `$100/month`

Current pricing signals for the proposed initial shape in `us-west-2` are favorable enough for a simple first deployment. Exact rates should be re-verified before provisioning, but the target remains a modest single-region footprint:

- EC2 `t4g.medium`
- 50 GB EBS gp3
- RDS PostgreSQL `db.t4g.small` Single-AZ
- RDS PostgreSQL gp3 storage sized initially around 20 GB
- Route 53 hosted zones

That places the core AWS app+database baseline in the mid-`$50/month` range before optional managed Redis, load balancers, or additional observability services.

## Decisions

### 1. Use AWS CDK as the Infrastructure-as-Code Framework in `infra/cdk/`

**Decision:** Define the initial AWS infrastructure using AWS CDK rather than Terraform or manual console-first provisioning. For the initial rollout, keep the CDK app under `engram/infra/cdk/`, but treat that location as transitional for any Cortex-owned shared infrastructure.

The intended longer-term ownership split is:
- shared Cortex infrastructure such as `cortex-shared-network`, `cortex-dev-dns`, `cortex-prod-dns`, `cortex-dev-data`, `cortex-prod-data`, `cortex-dev-app-host`, and `cortex-prod-app-host` should eventually live under `cortex/infra/cdk/`
- app-specific runtime stacks such as `engram-roland-app` should remain in the owning app repo

**Rationale:** The product team already works heavily in TypeScript/Node-based repositories. CDK keeps infrastructure definition in a language and tooling ecosystem that fits the existing workflow, makes it easier to express stack composition and shared constants in code, and reduces friction when infrastructure evolves alongside application code. Using `infra/` as the top-level infrastructure directory also matches the broader CORTEX workspace convention (for example `cortex/infra/helm/...`), while `infra/cdk/` leaves room for other infrastructure assets or tooling beside the CDK app later. Keeping the first rollout in `engram/infra/cdk/` reduces migration churn while the hosted shape is still settling, but the ownership boundary should still be documented now so the shared stacks can move into `cortex` later without ambiguity.

### 2. Split the Initial Infrastructure into Clear Stack Boundaries

**Decision:** The initial CDK implementation should separate infrastructure into these logical stack boundaries:

- **Shared network stack** — VPC, subnets, routing, and shared security-group foundations
- **Shared DNS stack** — Route 53 records for `login.ctxhost.com`, tenant roots, and wildcard routing as needed
- **Environment data stacks** — one shared data-plane stack per environment such as `cortex-dev-data` and `cortex-prod-data`
- **App stacks** — shared environment host stacks such as `cortex-dev-app-host` and `cortex-prod-app-host`, plus future app-specific/personal runtime deployables such as `engram-roland-app` that land on that shared host

These may be deployed as separate CDK stacks within one app, but the ownership boundaries should remain explicit.

**Rationale:** Clear stack boundaries improve maintainability and reduce the blast radius of changes. Networking, shared DNS, environment-scoped data, and app runtimes evolve at different cadences and should not be tightly entangled in one monolithic template.
### 3. Use EC2 for the Initial Application Tier, Not ECS/EKS

**Decision:** The initial AWS application tier runs on a single EC2 instance per deployed application runtime rather than ECS/EKS. The recommended environment model is:

- shared network stack (`cortex-shared-network`)
- environment DNS stacks (`cortex-dev-dns`, `cortex-prod-dns`)
- environment-scoped shared data stacks (`cortex-dev-data`, `cortex-prod-data`)
- shared environment app-host stacks (`cortex-dev-app-host`, `cortex-prod-app-host`)
- app-specific/personal runtime deployables such as `engram-roland-app` that run on the shared host

`staging` is explicitly deferred for now.

**Rationale:** A single EC2 host keeps operating cost and deployment complexity low while the suite is still validating its first external customer workflows. The system does not yet need Kubernetes, ECS service meshes, task definitions, or ALB-first orchestration. Using only `dev` and `prod` keeps the infrastructure lean while still allowing real deployment validation before touching production. Shared network and DNS avoid unnecessary duplication. A shared environment data plane prevents paying for separate RDS instances for every app or personal instance, while a shared environment app host prevents duplicating EC2 infrastructure for each suite application. App-specific and personal deployments should land on that shared host rather than each provisioning a separate EC2 stack at this stage.
### 4. Use Amazon RDS PostgreSQL Single-AZ for the Initial Primary Database

**Decision:** The initial relational data tier runs on Amazon RDS PostgreSQL Single-AZ as one shared environment-level data plane per environment rather than PostgreSQL on EC2, Aurora PostgreSQL, or one separate RDS instance per app/person.

`cortex-dev-data` and `cortex-prod-data` should each provision one managed PostgreSQL instance for that environment. Individual application stacks then use separate logical databases inside that shared environment-level RDS instance, for example:

- `engram`
- `engram_roland`
- `engram_ryan`
- future app-specific databases as needed

**Rationale:** The database holds durable product data and may contain PII-sensitive records. Managed PostgreSQL provides a better operational posture than self-hosting Postgres on the app host. Single-AZ is the right initial cost/resilience tradeoff for the current stage: it preserves backups, managed operations, and network isolation while keeping monthly cost within budget. A shared environment-level RDS instance also avoids multiplying database cost for every internal or personal app deployment target while still preserving logical isolation through separate databases.
### 5. Keep Redis-Backed Orchestration with the Local CORTEX Fleet Initially

**Decision:** The initial AWS deployment does not move the Redis-backed CORTEX orchestration plane into AWS. The local conductor and agents continue using the existing local Redis-backed bus and heartbeat substrate.

**Rationale:** Redis in CORTEX is not just a cache; it is the live coordination layer for dispatch, heartbeats, and ephemeral session state. Since the conductor and agents remain local, forcing that orchestration plane into AWS would add network complexity before it adds product value. The initial hosted apps should integrate with the local fleet over a secure private network path instead.

### 6. Use a Secure Private Connectivity Layer Between AWS and the Local Fleet

**Decision:** The AWS application tier must connect privately to the local CORTEX environment over a secure overlay network such as Tailscale rather than relying on open public endpoints.

**Rationale:** The apps need to reach the local orchestration plane safely while the conductor and agents remain off-cloud. A private connectivity layer reduces exposure and avoids designing the first hosted deployment around public access to sensitive internal services.

### 7. Keep the Initial Network and Edge Simple

**Decision:** The first deployment should avoid NAT Gateway, ALB, and WAF unless a concrete requirement appears. The EC2 instance provides the public edge for the application tier, and RDS remains private.

**Rationale:** NAT Gateway and ALB can materially increase the monthly floor. The current traffic profile and deployment shape do not justify those extra managed edge components yet. Simplicity is a feature at this stage.

### 8. Keep Engram as the Authentication System for the Initial AWS Rollout

**Decision:** The initial AWS migration keeps Engram's existing custom authentication architecture rather than migrating to Amazon Cognito.

**Rationale:** Engram already owns the suite's identity model, shared-domain browser SSO, refresh-token rotation, organization-aware account flows, and Bearer-token fallback for native/non-browser clients. Migrating infrastructure to AWS does not require replacing that auth boundary. Deferring Cognito reduces migration surface area while the team is already changing domains, deployment topology, and runtime hosting.

### 9. Prefer Operationally Conservative Defaults in the Data Tier

**Decision:** The initial RDS deployment should include:

- private subnets only
- no public database access
- encryption at rest enabled
- automated backups enabled
- application-only security-group access
- secrets stored outside application code and images
- one environment-level provisioning/admin secret for the shared RDS instance
- application/runtime-specific database URLs that target separate logical databases inside the shared RDS instance

**Rationale:** Using managed Postgres only helps if the surrounding operational posture is also disciplined. These are the minimum reasonable defaults for a system expected to hold customer data. Keeping one shared environment-level RDS instance with app-specific logical databases is only safe if credential ownership and database-targeting remain explicit.
## Considered Options

### A. AWS CDK + EC2 + RDS PostgreSQL Single-AZ + Local Redis Connectivity (CHOSEN)

Use CDK to define a simple AWS footprint with a single EC2 app host, RDS PostgreSQL Single-AZ for durable data, and secure private connectivity back to the local Redis-backed CORTEX orchestration plane.

**Chosen because:** It matches the current product architecture, keeps PostgreSQL off the application host, fits the team’s TypeScript workflow, and stays inside the current budget target without prematurely adding orchestration-heavy AWS services.

### B. Put the CDK App Under a Generic `infrastructure/` Directory

Use a standalone `infrastructure/` directory such as `engram/infrastructure/` for the AWS CDK code.

**Rejected:** This is workable, but it does not match the broader CORTEX convention as cleanly as `infra/`. `infra/cdk/` is shorter, fits alongside the existing `cortex/infra/helm/...` precedent, and preserves a cleaner top-level bucket for all infrastructure assets.

### C. Terraform Instead of CDK

Use Terraform as the primary infrastructure-as-code framework.

**Rejected:** Terraform is a valid alternative and remains common industry practice, but CDK is the better fit for the current team and codebase. The decision is about reducing day-to-day friction, not about maximizing infrastructure-tool orthodoxy.

### D. Manual AWS Console Provisioning First, IaC Later

Create the initial infrastructure manually in the AWS console, then codify it once the architecture stabilizes.

**Rejected:** This would make the initial deployment faster for a day and slower for every day after that. Reproducibility, reviewability, and future environment replication matter immediately.

### E. ECS or EKS for the Initial Application Tier

Deploy the applications using ECS/Fargate or Kubernetes rather than a single EC2 host.

**Rejected:** This is too much operational structure for the current stage. It raises cost and complexity before the workload actually needs service orchestration, autoscaling, or multi-node scheduling.

### F. PostgreSQL on EC2

Run PostgreSQL directly on the application EC2 instance to minimize cost.

**Rejected:** This weakens the operational and security posture for durable customer data and combines the application and database failure domains. It is explicitly at odds with the current requirement to avoid hosting Postgres on EC2.

### G. Separate RDS Instance Per App or Per Personal Deployment

Provision a dedicated RDS instance for each app runtime or personal Engram stack such as `engram-roland-app`.

**Rejected:** This would increase cost too quickly, complicate operations, and add unnecessary infrastructure duplication while the suite is still small. Separate logical databases within one shared environment-level RDS instance are the better initial tradeoff.

### H. Aurora PostgreSQL Instead of RDS PostgreSQL

Use Aurora PostgreSQL for the initial managed database tier.

**Rejected:** Aurora is stronger when there is a clear need for higher-end managed scale, replica patterns, or Aurora-specific operational benefits. The current stage does not justify its extra complexity or likely higher cost floor.

### I. Move Redis into AWS Immediately

Add ElastiCache/Valkey or self-hosted Redis in AWS from day one and make the local fleet connect into AWS for orchestration.

**Rejected for the initial deployment:** This becomes more attractive once the conductor and agents also move into AWS, but right now it complicates the network story without solving the main constraint. The orchestration plane should stay near the local fleet until the fleet itself moves.

### J. Migrate Engram Authentication to Amazon Cognito During the AWS Move

Replace Engram's current custom authentication system with Amazon Cognito as part of the initial AWS migration.

**Rejected for the initial deployment:** There is no current problem that Cognito uniquely solves strongly enough to justify the migration cost. Engram already supports the suite's core requirements: first-party login at a dedicated auth domain, shared-domain browser SSO, refresh-token rotation, organization-aware identity flows, and Bearer-token support for native/non-browser clients. Adopting Cognito now would increase migration risk while domains, infrastructure, and deployment workflows are also changing. This can be revisited later if enterprise federation, managed compliance posture, or team-operational constraints become strong enough to outweigh the product and migration cost.
### K. Move All AWS Infrastructure Immediately Into the `cortex` Repo Before the First Hosted Deploy

Move the shared platform stacks and the current Engram runtime infrastructure into `cortex/infra/cdk/` right now before completing the first working rollout.

**Rejected for the initial rollout:** The long-term ownership model does point toward shared Cortex stacks living in `cortex`, but moving repos immediately would add migration churn while the first hosted shape is still changing. It is better to stabilize the design and first successful deploy, then move the shared stacks into `cortex` as a follow-up.

## Migration Strategy

1. Create the CDK app and define separate shared-network, shared-DNS, environment-data, and app-runtime stacks
2. Provision the VPC, subnets, security groups, and Route 53 baseline
3. Provision Amazon RDS PostgreSQL Single-AZ as one shared environment-level data plane per environment
4. Provision EC2 application hosts with EBS, SSM access, and reverse-proxy ingress for each deployed app runtime
5. Join the EC2 host(s) to the private connectivity layer used for local CORTEX integration
6. Point the AWS-hosted applications at the local CORTEX services through that secure private path
7. For each app runtime, create or migrate its logical database inside the shared environment RDS instance
8. Validate tenant routing, Engram login, and product path-prefix routing on `ctxhost.com`
9. Add future managed components only when traffic, reliability requirements, or team operations justify them

## Consequences

### Positive

- Infrastructure lives in code and can be reviewed, versioned, and repeated
- CDK fits the existing team and application ecosystem well
- PostgreSQL stays off the application host
- Initial monthly cost remains comfortably below the current target budget
- The app tier stays simple while the product architecture settles
- The local CORTEX orchestration plane can remain unchanged during the first hosted rollout

### Negative

- The architecture still spans cloud-hosted apps and a local orchestration plane
- Single-EC2-host deployment keeps the app tier as a single failure domain
- Single-AZ RDS is a cost-conscious choice, not the strongest availability posture
- CDK is more AWS-specific than Terraform and increases IaC coupling to AWS concepts

### Risks

- **AWS ↔ local connectivity becomes brittle** — mitigated by using a deliberate private overlay network and testing reconnect/failure scenarios early
- **Single-EC2-host outages impact the whole application tier** — mitigated initially by backups, AMI/rebuild automation, and a future path to multi-host deployment if needed
- **Single-AZ RDS availability tradeoff** — mitigated by backups, tested restores, and a clear upgrade path to Multi-AZ later
- **CDK sprawl or overly clever abstractions** — mitigated by keeping stack boundaries simple and avoiding premature framework-building inside the CDK app

## Amendment Notes

### 2026-04-20 — Repository location clarified

- Recorded `infra/cdk/` as the chosen repository location for the AWS CDK app.
- Added `infrastructure/` as an explicitly considered but rejected directory alternative.
- Aligned the ADR with the implementation plan and the broader CORTEX `infra/` convention.

### 2026-04-20 — Cognito migration deferred

- Recorded that the initial AWS rollout keeps Engram's existing custom authentication architecture.
- Added Cognito migration as an explicitly considered but rejected option for the initial AWS move.
- Noted that Cognito can be revisited later if a concrete enterprise or operational requirement appears.

### 2026-04-20 — Initial region selected

- Selected `us-west-2` as the initial AWS region because the operator and expected clients are in California.
- Updated the implementation plan to use `us-west-2` as the default region target.
- Standardized on AWS CLI profile `cortex` for this rollout so operator commands and CDK deploys target the intended account consistently.

### 2026-04-20 — Shared environment data plane clarified

- Standardized the shared infrastructure naming to `cortex-shared-network`, `cortex-dev-dns`, `cortex-prod-dns`, `cortex-dev-data`, `cortex-prod-data`, `cortex-dev-app-host`, and `cortex-prod-app-host`.
- Clarified that the data stack is one shared RDS instance per environment, not one RDS instance per app or per personal deployment target.
- Clarified that the EC2 host is also shared at the environment level, not one EC2 instance per app.
- Clarified that personal or app-specific deployables such as `engram-roland-app` should land on the shared environment host while using their own logical database inside the shared environment RDS instance.
