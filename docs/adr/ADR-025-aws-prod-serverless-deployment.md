# ADR-025: AWS Prod Serverless Identity Deployment

- **Date:** 2026-07-13
- **Status:** Proposed

## Amendment Notes

- **2026-08-14:** §3 amended — **the RDS Proxy is removed.** Prod Lambda now connects
  directly to the Postgres instance, with the connection ceiling enforced in the
  application instead. Rationale, the cross-stack constraint it exposed, and the
  two-phase deploy it required are recorded in §3 below.
- **2026-08-14:** §11 relaxed. An agent **may** dispatch `deploy-prod.yml` when a human
  explicitly directs it to for that specific promotion, provided it rehearses with
  `--dry-run` and reports the plan first. It still may not promote on its own initiative,
  including inside an autonomous goal session, and still may not run `cdk deploy` directly.
  The DEPLOY REQUEST protocol is retained as the reporting format rather than as a request
  for someone else to execute. No stack set is carved out at the ADR-025 level: an agent so
  directed may dispatch `--full`, the cert stack, or any other combination. Prisma migration
  approval is unchanged and remains governed by ADR-032/ADR-033 and the bastion runbook —
  those are separate mechanisms, not `deploy-prod.yml` dispatches, and this amendment does
  not touch them. Rationale: the human decision per promotion is preserved; only the typing
  moves, and the guarded script already enforces every precondition a human would check.

## Context

Engram needs a production identity surface for `login.ctxhost.com` and `platform.ctxhost.com` to unblock Tradepost production. The launch scope is deliberately narrow: Engram provides identity-only production for the `tradepost-web` native PKCE client defined in [ADR-018](ADR-018-tradepost-native-client.md). Full hosted-suite production remains out of scope for this launch.

The existing Engram application is close to Lambda-ready: it is a Next standalone app, its request handlers are already stateless in the normal path, and Tradepost already uses Engram as an identity provider. The verified launch frictions are:

- the in-memory rate limiter is process-local and must have a shared production store;
- Prisma needs a production pooling posture suitable for Lambda;
- the [ADR-023](ADR-023-next-standalone-cookies-fix.md) standalone-cookie workaround must be verified under OpenNext;
- prod must not inherit dev-only HS256 signing, provider exposure, or suite signup behavior.

This ADR records the locked production architecture decisions for the wave-18 serverless build. It also draws a boundary with Cortex infrastructure policy: Cortex ADR-075 defines environment profiles for fleet backends, while this ADR defines Engram-owned application production stacks and runtime behavior.

## Decision

### 1. Launch Scope Is Identity-Only

Engram-prod launches as an identity provider for first-party clients, with Tradepost as the only production consumer at launch. It supports login, registration where allowed by client policy, OAuth callback handling, PKCE authorization-code issuance, token exchange, refresh, logout, `/api/me`, app-switcher reads required by clients, and the minimal platform/admin surfaces needed to operate identity.

The launch explicitly excludes Nexus, Synapse, tenant workspace hosting, Caddy/on-demand tenant TLS, gateway routing, suite production, wildcard tenant hosts, and per-org BYO provider credentials. [ADR-021](ADR-021-org-provider-credentials-store.md) remains accepted for BYO provider credentials, but that capability is not exposed in this production identity launch.

### 2. Runtime Topology Uses OpenNext on Lambda

The production web tier is an OpenNext deployment behind CloudFront:

- `login.ctxhost.com` is the primary auth origin.
- `platform.ctxhost.com` hosts platform/admin surfaces that are needed for identity operations.
- ACM certificates for these hostnames are issued in `us-east-1`.
- CloudFront fronts the OpenNext Lambda/S3 assets.
- Route 53 aliases point the two hostnames at CloudFront.
- AWS WAF is attached to the distribution with managed-rule and rate-based protections.

Phase 1 must prove this shape against dev data before production stacks become mergeable. The proof must include password login, magic link, refresh rotation, PKCE authorize/token exchange, `/api/me/app-switcher` CORS, admin server-component rendering, the ADR-023 cookie fallback behavior, and shared rate limiting across Lambda concurrency.

### 3. Data Layer Uses Dedicated Production Postgres

Engram-prod owns a dedicated PostgreSQL database. The data stack provisions a small
provisioned RDS instance, which the OpenNext Lambda connects to **directly**.

**Amendment, 2026-08-14 — the RDS Proxy is removed.** It was originally specified to
pool Lambda's connection fan-in. Measured over the seven days to 2026-08-14, prod
peaked at **9 concurrent Lambda executions and 9 backend connections** against a
`db.t4g.micro` at 3.4% CPU. A connection pooler was not earning its ~$22/month, which
was the second-largest idle line on the AWS account.

The pooling contract moves into the application. `src/lib/prisma-config.ts` caps the
per-container `pg` pool at **3** when `AWS_LAMBDA_FUNCTION_NAME` is present, with 10 s
idle and connect timeouts. This is load-bearing, not incidental: without a pooler the
ceiling is `concurrency × pool size`, and node-postgres defaults to **10**, so roughly
eleven warm containers could exhaust `db.t4g.micro`'s ~112 connections — an outage on
the auth service under precisely the traffic spike you would least want one. Long-lived
container deployments (aws-dev, on-prem) deliberately keep the library default; they
serve many concurrent requests from one process and a pool of 3 would throttle them.

Measured after the cutover: a steady **4** connections on the direct path.

**The cross-stack constraint this exposed is the durable lesson.** CloudFormation
exports are generated from *references*, not resources. CDK emitted the proxy-endpoint
export only because `EngramProdWebStack` read `prodData.proxy.endpoint`; repointing
`DATABASE_URL` at the instance deleted that reference and therefore the export, and
CloudFormation refuses to delete an export another stack still imports:

```
Cannot delete export engram-prod-data:ExportsOutputFnGetAttRdsProxy…Endpoint
as it is in use by engram-prod-web.
```

Three prod deploys failed on this. No ordering of the change fixes it, and neither
would reverting — **every** variant where the web stack stops referencing the proxy
drops the export. The resolution is `Stack.exportValue()` to pin the export alive
through an intermediate deploy, then remove the resource and the pin together:

1. Ship the proxy **plus** `exportValue(proxy.endpoint)`, with `DATABASE_URL` repointed
   at the instance. Nothing is deleted; the web stack stops importing.
2. Ship the removal of both. The export is now unimported and deletes cleanly.

**Any future change that removes a cross-stack export must follow this shape.** Both
deploys completed with zero downtime — 90/90 and 191/191 health samples returned 200 —
because the same CloudFormation rule that blocks the delete also prevents the outage.

Note that the guard cuts both ways: while it held, **aws-prod could not deploy at
all** — `engram-prod-web` alone also failed, because the replacement import it needed
was published by the same blocked data-stack update. Treat an export-in-use failure as
an availability incident, not just a failed change.

**D1 amendment, 2026-07-14:** Roland reviewed the real launch estimate and chose `db.t4g.micro` single-AZ for the pre-launch production cut. This trades availability, not data safety: an AZ failure or maintenance event can take Engram auth down for the whole suite while the database is unavailable. That is acceptable before launch while there are zero production users. The durability controls below remain mandatory. Converting to Multi-AZ later is an online RDS modify with no data loss.

Production database safeguards are required from day one:

- point-in-time recovery is enabled;
- a dump-based backup job also runs from day one;
- deletion protection and retained snapshots are enabled;
- production secrets live only under `cortex/prod/engram/*` in AWS Secrets Manager;
- no dev database, dev secret value, or local secret value may be copied into production.

Prisma migrations remain human-gated. Any PR that touches `prisma/migrations/**` waits for Roland approval before merge.

Implementation note from the Phase 1 OpenNext spike: pass the pg **configuration
object** into `new PrismaPg(...)`, not a constructed `pg.Pool` instance. OpenNext
Lambda bundles can contain more than one physical `pg` module copy, so
`instanceof pg.Pool` checks inside `@prisma/adapter-pg` can fail even when the
object is a Pool from the application's copy of `pg`. When that happens the
adapter treats the Pool instance as a config object with no top-level
`connectionString`/`host`, and node-postgres falls back to `127.0.0.1:5432`.
Passing the config returned by `buildPgPoolConfig()` is equivalent on the
standalone container path and avoids module-instance identity entirely while
preserving the AWS-dev `sslmode` stripping behavior.

### 4. Prod JWTs Use RS256 and JWKS

Production Engram signs JWTs with RS256 and exposes a JWKS endpoint for consumers. Engram-prod is the only holder of the private signing key. Consumers verify via JWKS and cannot mint tokens.

Implementation requirements:

- the private key is loaded from AWS Secrets Manager by name only;
- public keys are exposed through a JWKS route with `kid` support;
- verification supports the production RS256/JWKS path;
- dev remains HS256-compatible until separately migrated;
- no production private key value is committed, printed, copied from dev, or handled by the agent.

[ADR-014](ADR-014-jwt-signing-key-distribution.md) described JWKS as the long-term direction while keeping HS256 short term. This ADR selects that long-term direction for production launch while preserving current dev behavior.

### 5. Production Cookies Are Host-Only

Production browser cookies are secure, HTTP-only, same-site, and host-only on `login.ctxhost.com`. Engram-prod does not set a `.ctxhost.com` apex cookie at launch.

Tradepost uses the existing native PKCE code-exchange flow rather than relying on a shared apex browser cookie. This keeps the production auth boundary narrow and avoids granting ambient auth to every future `ctxhost.com` application before the suite cookie model is deliberately rolled out.

### 6. Rate Limiting Becomes Dual-Mode

The existing in-memory limiter remains valid for local development. Production and OpenNext environments use a shared AWS-backed limiter, initially a DynamoDB fixed-window table with TTL. When the shared limiter is configured, all Lambda instances must enforce the same counters.

This is an additive runtime switch. Local development must keep working without AWS credentials or a DynamoDB table.

### 7. Branded Auth Is NativeAuthClient-Scoped

Login, register, and recovery pages are branded from the PKCE `client_id`, using fields on `NativeAuthClient`. Pages remain hosted on Engram's origin; clients never host credential-entry forms.

The default path remains compatible with current Engram behavior. Clients without branding fields render the existing Engram look.

### 8. Provider Exposure Is Per Client and Per Environment

Auth pages render provider buttons from configuration, not hardcoded providers. Production exposes Google OAuth only because no GitHub production app is provisioned. Dev continues to support the existing Google and GitHub flows so `login.dev.ctxhost.com` does not regress.

Provider credentials are Engram-owned and environment-specific. Production provider secret values are created by the controller/Roland in AWS Secrets Manager; they are never copied from dev.

### 9. Signup Policy Is Per Client

**Amended 2026-07-13:** `tradepost-web` launches waitlist-first, not open. Hosted-suite clients also remain waitlist-gated unless a later ADR changes their admission model.

The policy is stored per native client and defaults to the current waitlist-gated behavior. `signupMode` has two values:

- `waitlist`: the client-branded register page captures a waitlist request tagged with the native client. Tradepost waitlist requests may include optional prioritization enrichment: collection size bracket, formats played, requested Tradepost capabilities, and a short free-text reason. Email alone is sufficient. Platform-admin batch approval creates identity-only users with no organization membership and sends the existing ADR-017 set-password email. The account does not activate until that purpose-bound email link is consumed.
- `open`: the client-branded register page creates an identity-only user directly, but the user remains inactive until a single-use `verify_email` magic link is consumed. Password login rejects unverified users. OAuth signup is allowed only when the provider supplies a verified email, preserving the existing provider-verified-email rule.

Migration 0017 explicitly grandfathers existing users that already have password hashes but `emailVerified=false`, setting them verified before the login gate ships. Those accounts predate the verification gate and were created through trusted admin or seed paths, so silently locking them out would be an outage rather than a security improvement. New password accounts created after the gate must prove email control before activation.

This preserves suite behavior while allowing Tradepost to switch from waitlist to open signup later by registry change rather than deploy. The Phase 2 implementation is dev-verifiable except email-send completion while `RESEND_API_KEY` is absent from the dev runtime; those checks are recorded as pending-key rather than skipped.

### 10. Production Stacks Are Engram App-Scoped

The Engram repo owns new production stacks named:

- `engram-prod-cert`
- `engram-prod-data`
- `engram-prod-web`
- `engram-prod-ops`

This follows the app-scoped stack precedent noted in Cortex shared-platform ownership work while avoiding further mutation of legacy shared-platform stack copies in this repo. Those legacy copies are retirement drift owned by Cortex; Engram production should not depend on extending them.

### 11. Prod Deploy Is Dispatch-Only and Human-Directed

aws-prod never auto-deploys from a merge. The dispatch-only workflow
(`.github/workflows/deploy-prod.yml`), driven by `scripts/promote-prod.sh`, is the only
sanctioned path. **No actor — human or agent — runs `cdk deploy` directly against prod.**

An agent **may** dispatch the workflow when a human explicitly directs it to for that
specific promotion. Before dispatching it must run `--dry-run` and report the resulting
plan. An agent **must not** promote on its own initiative — not on a merge, not on a
schedule, and not inside an autonomous goal session. "Deploy when ready" is not a
direction to promote; each promotion needs its own instruction.

Amended 2026-08-14; previously the dispatch itself was human-executed. The decision per
promotion is still human. What changed is who types the command.

When a phase reaches a deployable state, the PR or progress log must post a
**DEPLOY REQUEST** containing:

- exact stack names;
- the `cdk diff` summary;
- any bootstrap or one-time human action required;
- the expected verification steps.

This is now the reporting format for a promotion an agent may itself dispatch, rather than
a request for someone else to execute it. If credentials or console actions are needed, the
agent still stops instead of improvising.

### 12. WAF, Budgets, Logs, and Alarms Are Part of Launch

The production web stack includes WAF managed rules and rate-based rules. The ops stack includes budget/usage alarms, backup-job alarms, and log retention policies sufficient to operate the identity surface.

Launch observability focuses on auth availability, token issuance, OAuth callback failures, rate-limit health, backup completion, and CloudFront/Lambda error rates.

## Consequences

- Tradepost production can depend on an Engram production identity origin without waiting for suite production.
- Engram-prod does not mint HS256 tokens and does not share a signing secret with consumers.
- Production cookies do not provide cross-subdomain browser SSO; clients must use PKCE until a later suite-cookie ADR expands the boundary.
- The OpenNext spike is decisive. If ADR-023 cookie behavior, Prisma connection-pooling behavior, or Lambda rate-limit behavior fails structurally, implementation stops and the fallback returns to Roland.
- The first production migration and seed flow require explicit human approval and must not be bundled into an unattended deploy. Migration approval is governed by ADR-032/ADR-033 and the bastion runbook and is unaffected by the 2026-08-14 dispatch amendment.
- Dev auth behavior is protected: HS256, both current OAuth providers, and waitlist-gated suite flows remain supported until separately changed.

## Non-Goals

- No EC2/Caddy production deployment for Engram.
- No Nexus, Synapse, hosted tenant workspace, wildcard tenant TLS, or gateway production rollout.
- No BYO provider credentials in production launch.
- No `.ctxhost.com` apex auth cookie.
- No production secret values in git, logs, PR bodies, or agent-visible output.
- No `cdk deploy` run directly against prod by any actor, agent or human; the guarded workflow is the only path.
- No agent-initiated promotion — an agent dispatches only when explicitly directed for that promotion.
- No Prisma migration without Roland approval.

## Verification

Phase 0 is documentation-only. Later phases must verify:

- `npm run lint && npm run typecheck` before every push;
- OpenNext spike exit criteria on the controller-deployed throwaway URL;
- `cdk synth` and `cdk diff` from the agent side; `cdk deploy` from neither side;
- a `--dry-run` rehearsal reported before any dispatch, whoever dispatches;
- DEPLOY REQUEST rows before any prod deployment;
- live dev verification for branded auth/provider/signup behavior;
- no regression to current dev login providers or suite waitlist behavior.
