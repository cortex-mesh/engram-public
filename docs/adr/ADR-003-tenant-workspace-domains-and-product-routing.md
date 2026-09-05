# ADR-003: Tenant Workspace Domains and Product Routing

**Status:** Proposed
**Date:** 2026-04-20
**Last Updated:** 2026-04-20
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-002 (Native Client Authentication), Synapse ADR-014 (Organizations and Multi-Tenancy)

## Context

Engram now owns centralized identity and organization membership for the suite. The next architectural question is how tenant-facing domains should work for external organizations on `ctxhost.com`.

The suite needs to support:

- a single identity provider login surface
- multiple organizations, with a user potentially belonging to more than one org
- multiple products per organization, starting with Synapse and Thoughts and expanding to future products like Pulse
- a clean URL model that is easy for users to understand and easy for the platform to route
- a deployment model that can start simple, remain affordable, and stay portable across infrastructure providers

The initial ideas considered included:

- `login.ctxhost.com` for Engram, then org-specific subdomains like `cortex.ctxhost.com`
- app-specific org domains such as `cortex.ctxhost.com` for one product and path-based routing for others
- product-per-subdomain-per-org such as `synapse.cortex.ctxhost.com`
- path-based org routing such as `ctxhost.com/cortex/synapse`

There is also a hosting decision adjacent to this routing model. AWS is acceptable, but it should not force a more complex deployment architecture than the product currently needs. Current AWS pricing signals reinforce that point:

- AWS Lightsail Linux instances currently start at fixed tiers including `$3.50`, `$5`, `$7`, and `$12` per month depending on bundle size
- AWS Lightsail container service currently starts at `$10/month` for the micro single-node tier
- AWS Lightsail managed database currently starts at `$15/month`
- Route 53 public hosted zones currently cost `$0.50` per hosted zone per month for the first 25 hosted zones
- AWS Application Load Balancer pricing examples show a light-traffic monthly cost around `$22.42/month` before adding compute and database costs

Those numbers make AWS viable, but they also show that managed-LB-heavy designs have a noticeably higher monthly floor than a simple single-host reverse-proxy deployment.

## Decisions

### 1. `login.ctxhost.com` is the Dedicated Authentication Entry Point

**Decision:** Engram is hosted at `login.ctxhost.com` and remains the single browser authentication entry point for the suite on `ctxhost.com`.

**Rationale:** This preserves the identity-provider boundary established in ADR-001. Users learn one place for sign-in, password resets, account management, and organization-aware session continuation. Product applications do not own login UIs.

### 2. `<org>.ctxhost.com` is the Organization Workspace Home

**Decision:** Each tenant root domain (for example `cortex.ctxhost.com` or `dbest.ctxhost.com`) lands on an organization workspace dashboard rather than opening a specific product directly.

**Rationale:** The naked org domain should represent the organization itself, not one particular product. This creates a durable suite entry point that still works as new products are added. It also gives the platform a natural place for workspace-wide navigation, recent activity, member management, billing, announcements, and future cross-product search.

### 3. Products Mount Under the Organization Domain as Path Prefixes

**Decision:** Suite products are mounted under the tenant domain using path prefixes:

- `<org>.ctxhost.com/synapse`
- `<org>.ctxhost.com/thoughts`
- `<org>.ctxhost.com/pulse`

Future products should follow the same pattern unless a later ADR defines an explicit exception.

**Rationale:** This keeps the URL model consistent:

- subdomain = organization
- path prefix = product

It minimizes DNS and certificate sprawl, keeps the workspace shell concept strong, and makes it straightforward to add more products without inventing new domain patterns.

### 4. Multi-Org Users Authenticate Once, Then Resolve Organization Context Explicitly

**Decision:** Authentication and tenant selection are separate concerns:

- users authenticate at `login.ctxhost.com`
- if the destination already identifies an organization and the user belongs to it, continue directly
- if the user belongs to multiple organizations and no tenant is yet resolved, present an organization picker
- after tenant selection, redirect back to the originally requested product path when possible

The platform should remember the user’s last active organization for convenience, but it must always keep organization switching available in the UI.

**Rationale:** A user can belong to more than one organization, so login cannot assume a single permanent tenant context. Separating identity from current org context matches the multi-tenant model already chosen for the suite.

### 5. Browser SSO Must Work Across `ctxhost.com` Subdomains, While Product Routing Happens at the Reverse Proxy Layer

**Decision:** Browser sessions continue to use Engram’s shared-domain cookie strategy for the parent domain. Reverse-proxy routing handles:

- `login.ctxhost.com` → Engram
- `*.ctxhost.com/` → workspace dashboard
- `*.ctxhost.com/synapse` → Synapse
- `*.ctxhost.com/thoughts` → Thoughts
- `*.ctxhost.com/pulse` → Pulse

Consumer applications must explicitly support path-prefix deployment, including asset URLs, fetch paths, WebSocket paths, and auth redirect targets.

**Rationale:** The auth model and the URL model should complement each other. Shared-domain cookies fit the subdomain-based tenant model, while reverse-proxy path routing keeps the external surface coherent. The main implementation cost is base-path correctness inside each product, which is acceptable and localized.

### 6. The Initial Hosting Posture Should Be a Simple Single-Host Reverse-Proxy Deployment, Not a Container-Orchestration Platform

**Decision:** The preferred initial production architecture is:

- one public EC2 host or equivalent VM for the application tier
- one reverse proxy (Caddy or equivalent)
- Engram, workspace shell, and product containers behind it
- wildcard DNS for `*.ctxhost.com`
- Amazon RDS PostgreSQL for durable relational data, with an initial Single-AZ deployment

AWS is acceptable for this, but the platform should start with the simplest deployment shape that satisfies reliability requirements. Avoid ECS, EKS, or similarly heavy orchestration for the first version unless operating constraints change materially. Do not host the primary PostgreSQL database on the application EC2 instance.

**Rationale:** The suite already fits a reverse-proxy-plus-containers model well. A single-host application tier has lower operational overhead, lower monthly cost, and fewer moving parts while the product and tenant model are still stabilizing. Using RDS PostgreSQL instead of self-hosted Postgres gives a stronger operational and security posture for PII-sensitive data, while Single-AZ keeps the managed database cost inside the current target budget.

### 7. Redis and Local-Agent Connectivity

**Decision:** Because the CORTEX conductor and agents remain local, the initial AWS deployment should treat Redis-backed orchestration as part of the local fleet rather than forcing it into AWS immediately. The AWS-hosted applications connect privately back to the local CORTEX environment over a secure network path such as Tailscale. If the orchestration plane later moves into AWS, Redis should remain a dedicated coordination service rather than being replaced with PostgreSQL.

**Rationale:** Redis is not just a cache in the current architecture; it is the message bus, heartbeat substrate, and ephemeral coordination layer for CORTEX. Keeping that live coordination plane colocated with the local conductor and agents avoids unnecessary cross-cloud orchestration complexity in the first deployment. It also preserves the clean split between RDS PostgreSQL for durable business data and Redis for transient orchestration state.

### 8. AWS Is a Valid Hosting Provider, But Not a Required Architectural Dependency

**Decision:** The `ctxhost.com` architecture remains cloud-portable. AWS is the selected initial deployment target, using EC2 for the application tier and RDS PostgreSQL Single-AZ for the primary relational database, but the domain and routing model must not depend on AWS-specific services.

**Rationale:** The product decision is about identity, tenant routing, and suite navigation — not about coupling to a single cloud vendor. Keeping the design provider-neutral preserves freedom to choose AWS now for convenience and managed-data posture, while still allowing a later move if cost or operational needs change.

## Considered Options

### A. Organization Workspace Root + Product Paths (CHOSEN)

Use:

- `login.ctxhost.com`
- `<org>.ctxhost.com`
- `<org>.ctxhost.com/synapse`
- `<org>.ctxhost.com/thoughts`
- `<org>.ctxhost.com/pulse`

**Chosen because:** It creates the clearest long-term suite model: identity at a dedicated login domain, organization at the subdomain, and product at the path. It scales well as more products are added and gives multi-org users an intuitive workspace-oriented experience.

### B. Product-Per-Subdomain-Per-Organization

Use domains such as:

- `synapse.cortex.ctxhost.com`
- `thoughts.cortex.ctxhost.com`

**Rejected:** This creates too much DNS and certificate sprawl and weakens the idea that the organization root is the main workspace. It also makes cross-product navigation and shared shell patterns more awkward.

### C. Organization in the Path Instead of the Subdomain

Use URLs such as:

- `ctxhost.com/cortex/synapse`
- `ctxhost.com/dbest/thoughts`

**Rejected:** This weakens tenant identity, makes future custom-domain support harder, and is less natural for organization switching. It also gives up the clean wildcard-subdomain model that aligns well with Engram’s shared-domain cookie strategy.

### D. Make the Org Root Open Directly Into a Single Product

Use the naked organization domain as a product entry, for example:

- `cortex.ctxhost.com` opens Synapse directly
- `cortex.ctxhost.com/thoughts` hosts another product

**Rejected:** This overfits the URL model to today’s product mix and makes the root domain semantically unstable. As soon as the suite has more than one serious product, the root should represent the workspace, not whichever app happened to come first.

### E. AWS-Native Managed Platform First (ALB + ECS/EKS + Managed Services)

Build the first version around a heavier AWS-managed topology.

**Rejected:** This adds meaningful cost and operational complexity too early. Current AWS pricing signals show a non-trivial baseline even before adding core application compute and storage, with Route 53 hosted zones at `$0.50/month`, Lightsail container service starting at `$10/month`, Lightsail managed database starting at `$15/month`, and an Application Load Balancer example at roughly `$22.42/month` before compute. The product does not yet justify orchestration-first complexity.

### F. EC2 Application Tier + RDS PostgreSQL Single-AZ (CHOSEN INITIAL AWS POSTURE)

Deploy the application tier on a single EC2 host, keep the primary relational database on Amazon RDS PostgreSQL Single-AZ, and connect back privately to the local CORTEX orchestration plane while agents remain local.

**Chosen because:** This keeps the database off the application host, improves the operational posture for PII-sensitive data, stays inside the current budget target, and avoids the extra complexity of forcing the Redis-backed orchestration plane into AWS before the conductor and agents move there.

### G. Cheaper VM Provider First

Deploy the same reverse-proxy architecture on a lower-cost VM provider rather than AWS.

**Not chosen as the architectural decision:** This remains a valid deployment option and may be the best economic choice, but it is a hosting-provider choice rather than the core architectural decision. The ADR therefore keeps the architecture portable so this can be decided operationally.

## Migration Strategy

1. Stand up Engram on `login.ctxhost.com`
2. Introduce Nexus as the workspace shell that serves `<org>.ctxhost.com`
3. Configure wildcard DNS and reverse-proxy routing for `*.ctxhost.com`
4. Mount Synapse and Thoughts behind organization-aware path prefixes
5. Ensure each product correctly supports path-prefix deployment and deep-link redirects
6. Add organization picker and last-active-org behavior for multi-org users
7. Provision the initial AWS footprint with EC2 for the application tier and RDS PostgreSQL Single-AZ for durable relational data
8. Keep Redis-backed orchestration with the local CORTEX fleet until the conductor and agents themselves move to AWS
9. Add future products such as Pulse under the same routing pattern

## Consequences

### Positive

- Clear long-term suite information architecture
- Clean separation of identity, organization context, and product context
- Strong workspace-home model for multi-product organizations
- Simple wildcard-subdomain story for tenant routing
- Lower initial infrastructure complexity than orchestration-heavy deployments
- Freedom to start on AWS or move to another provider later without redesigning URLs

### Negative

- Path-prefix hosting adds implementation work to each product
- The workspace shell becomes an additional surface to design and maintain
- Reverse-proxy rules and deep-link handling must be carefully tested

### Risks

- **Base-path regressions in product apps** — mitigated by explicit path-prefix support, link auditing, and end-to-end tests
- **Confusing multi-org redirects** — mitigated by preserving destination paths and adding a clear org picker when tenant context is ambiguous
- **Premature cloud coupling** — mitigated by keeping the architecture provider-neutral even if AWS is used first
- **Workspace shell bloat** — mitigated by keeping the org root focused on navigation, recent activity, and organization-level actions rather than turning it into another monolithic product
- **Single-AZ RDS availability tradeoff** — mitigated initially by automated backups, tested restore procedures, and a clear upgrade path to Multi-AZ when the uptime and customer profile justify the higher monthly cost

## Amendment Notes

### 2026-04-20 — Initial AWS posture selected

- Clarified that the initial AWS application tier runs on EC2 rather than Lightsail.
- Recorded Amazon RDS PostgreSQL Single-AZ as the initial managed database choice.
- Explicitly rejected hosting the primary PostgreSQL database on the EC2 app host.
- Documented that Redis-backed orchestration remains with the local CORTEX fleet while the conductor and agents stay local.
