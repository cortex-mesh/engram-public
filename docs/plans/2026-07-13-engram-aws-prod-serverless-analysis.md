# Engram aws-prod — Serverless Deployment Analysis & Plan

_2026-07-13 · Author: Fable (controller) · Status: **ANALYSIS ONLY — no implementation authorized** · Requested by Roland: "prod version of Engram, fully serverless if possible, to unblock tradepost-prod."_

## Verdict up front

**Fully-serverless Engram-prod is feasible and is the recommended path.** Engram is the most Lambda-ready app in the suite: Next 16.2.9 `output: "standalone"`, 40 stateless API routes + 11 pages, **no websockets, no crons, no server actions, no Redis**. Tradepost already runs the exact same Next version under `@opennextjs/aws` 4.0.3 in the same AWS account — the pattern, the deploy workflow shape, the OIDC role model, and the CloudFront/Route53/ACM plumbing are all proven in-house.

**The unlock is bigger than it looks:** per engram ADR-018, tradepost is an *identity-only* native-auth client (org-tenancy not required), and its **prod redirect URI is already registered** (migration 0014). So the minimal chain to tradepost-prod is exactly two pieces: serverless Engram-prod + tradepost's own already-parameterized prod stacks (`-c env=prod -c allow-prod=true`). **No prod EC2 app-host, no Caddy, no Nexus, no tenant wildcard TLS needed for this goal.** The full-suite prod (ADR-075 §7 aws-prod.toml, gateway, tenant hosts) remains a later program; nothing here blocks or is blocked by it.

## The four serverless frictions (all solvable, none architectural)

| # | Friction | Evidence | Resolution |
|---|---|---|---|
| 1 | **In-memory rate limiter** on login/refresh/token/magic-link (`src/lib/rate-limit.ts` — its own comment: "swap the Map for a shared store" when horizontal) | per-process Map | Small DynamoDB fixed-window table (PAY_PER_REQUEST, TTL). ~1 day of work, keeps limits correct across Lambda concurrency. |
| 2 | **Prisma + `pg` connection pooling** on Lambda | `@prisma/adapter-pg` direct pool | **RDS Proxy** in front of prod Postgres (standard answer; Prisma-over-TCP works unmodified). Lambda concurrency stays naturally low at Engram's traffic. |
| 3 | **ADR-023 middleware cookie workaround** (Next 16.2.x standalone `cookies()`-empty-in-RSC) | `src/middleware.ts` header forwarding | OpenNext uses its own server wrapper, not the stock standalone server — behavior under OpenNext is **unverified**. This is the #1 item for the Phase-1 spike. Middleware itself runs fine under OpenNext; worst case the workaround is simply unnecessary there. |
| 4 | **Caddy on-demand-TLS `ask` endpoint** (`/api/internal/tls/allow`, loopback-only) | assumes co-located Caddy | **Not needed on this path.** Serverless prod uses ACM certs on CloudFront (`login.ctxhost.com` + `platform.ctxhost.com` as alternate names). The ask endpoint stays for dev/on-prem; prod tenant wildcard TLS is a full-suite-prod concern, and even then a single ACM `*.ctxhost.com` wildcard covers org hosts. |

## Data layer — the one real cost/architecture decision (Roland gate)

Prod Engram gets its **own Postgres and own org registry** (ADR-075 §7, engram ADR-004 — never shared with dev). The engram repo's own CDK (`infra/cdk/lib/data-stack.ts`) is already prod-parameterized (multi-AZ, RETAIN, deletion protection at `DEPLOY_ENV=prod`). Options:

- **Option A — Aurora Serverless v2 (0.5 ACU floor) + RDS Proxy.** Most serverless; scales with load; ≈ $45–65/mo floor. New construct (dev uses provisioned RDS) — slightly more CDK work.
- **Option B — provisioned `db.t4g.micro`/`small` multi-AZ + RDS Proxy.** Mirrors the dev stack shape exactly (least new code); ≈ $25–50/mo. Not "scales-to-near-zero" but Engram's DB load is tiny (16 models, auth-shaped queries).
- Either way: PITR **plus a real dump-based backup job from day one** — the aws-dev RDS is a known PITR-only gap; prod must not inherit it.

**Recommendation: Option B** for launch (identical operational model to dev, cheapest path to correct), revisit ASv2 if traffic ever warrants. "Fully serverless" purism isn't worth new failure modes on the identity database.

## Security items to decide at the gate (Roland)

1. **JWT algorithm for prod.** Today the whole suite shares one HS256 secret — every holder can *mint* tokens (ADR-014 acknowledges this and plans asymmetric). Prod-from-scratch is the cheapest moment to launch **RS256/EdDSA + a JWKS endpoint**: Engram-prod holds the only private key; tradepost-prod verifies via JWKS and can never mint. Moderate change (jwt.ts + consumer verify path). **Recommended for prod launch**; fallback is HS256 shared between exactly two parties (Engram-prod, tradepost-prod), migrating later.
2. **Cookie domain scope.** `ENGRAM_COOKIE_DOMAIN=.ctxhost.com` makes prod session cookies visible to `*.dev.ctxhost.com` hosts (dev lives under the prod apex). Dev can't *verify* prod tokens (different keys), but a compromised dev host could *exfiltrate* prod cookies. Mitigations: launch tradepost-prod with **host-only cookies on login.ctxhost.com + PKCE redirect** (tradepost doesn't need SSO cookies — it exchanges codes), deferring the `.ctxhost.com` SSO cookie until full-suite prod; or accept the standard-industry risk. Recommend the former — it costs nothing on this path.
3. **CMK for provider credentials** — ADR-021 D2 explicitly defers the dedicated KMS key to "pre-aws-prod hardening." That bill is now due if provider credentials go live in prod (they can also simply stay disabled in prod at launch — recommend that, deferring CMK until BYO-keys is a prod feature).
4. **WAF.** New for prod: AWS WAF managed core + rate-based rules on the CloudFront distribution in front of the auth endpoints. Cheap (~$10/mo), high value on an internet-facing login.
5. **aws-prod never auto-deploys** (existing policy, `docs/topology/environments.md`): the deploy workflow gets a `deploy-aws-prod` job that is `workflow_dispatch`-only with the launch-note checklist (`cortex/docs/launch-notes/aws-prod/README.md` — the template already exists and is good).

## Phased plan (analysis of effort; nothing started)

**Phase 0 — ADR (1 session).** Engram ADR: "aws-prod serverless deployment architecture" covering everything above + the deliberate scope cut (identity-only prod; platform-admin included; org-tenant/gateway/full-suite explicitly out). Cross-reference, don't amend, cortex ADR-075 (this path doesn't need `aws-prod.toml` — that file gates *fleet/app-host* prod, not Engram-prod).

**Phase 1 — OpenNext spike (1–2 sessions, cheap, decisive).** Build Engram with `@opennextjs/aws` into a `personal`-tier stack (tradepost's env pattern) against the **dev** RDS through a temporary dev RDS Proxy. Exit criteria: full login flow (password + magic link), refresh rotation, PKCE authorize/token exchange, `/api/me/app-switcher` CORS, admin RSC pages (the ADR-023 cookie behavior), rate-limit table swap — all green on a throwaway URL. **This spike converts every "should work" above into "works."** If it fails structurally → fallback: Fargate single-task behind CloudFront (still no EC2 to manage), decision returns to Roland.

**Phase 2 — prod stacks in the engram repo (1–2 sessions).** `engram-prod-{cert,data,web,ops}` mirroring tradepost's stack anatomy: us-east-1 ACM cert (login + platform hostnames), Postgres per the Option A/B decision + RDS Proxy, OpenNext web stack (server fn ARM64 + warmer + assets bucket + CloudFront + Route53 aliases + WAF), rate-limit DynamoDB table, per-key prod secrets `cortex/prod/engram/*` (ADR-081 kept per-key "for aws-prod consideration" — use it), AWS Budgets. Deploy role: `EngramAwsProdGithubDeploy` OIDC role, dispatch-only workflow job.

**Phase 3 — provisioning (human-heavy, Roland's console work + gates).** Prod Google/GitHub OAuth apps with `login.ctxhost.com` redirect URIs · Resend prod domain verification + key (`EMAIL_FROM@ctxhost.com` DNS records) · generate prod JWT keys into Secrets Manager · run migrations 0001–0016 against the prod DB (migration-guard applies) · seed the prod org registry + superadmin via the launch-note flow · set the seven `NEXT_PUBLIC_*_URL` catalog vars to prod values (apps not yet in prod can point at their future URLs or be entitlement-hidden).

**Phase 4 — cutover per the existing launch-note template.** CDK diff review, secrets dev-value scan, smoke (health + full auth matrix + PKCE from a tradepost-prod build), rollback plan, manual deploy. Then **tradepost-prod unblocks immediately**: its own gated `cdk deploy -c env=prod -c allow-prod=true`, budgets, and the already-seeded native-auth client.

## Cost envelope (monthly, steady-state, low traffic)

Engram-prod serverless: Lambda ≈ $0–5 · CloudFront ≈ $1–5 · DynamoDB rate-limit ≈ $1 · **Postgres+Proxy ≈ $25–50 (Option B) / $45–65 (Option A)** · Route53/ACM ≈ $1 · WAF ≈ $10 → **≈ $40–85/mo, dominated by Postgres.** (Versus a prod EC2 app-host mirror: t4g.medium + EIP + volumes ≈ $35–45/mo but with patching/capacity/single-instance ops burden — serverless wins on ops, roughly ties on cost.) Tradepost-prod adds its own ≈ $15–40 (Dynamo PPR, Lambda, CloudFront; its ops-stack already carries a $50 prod budget placeholder).

## What this plan deliberately does NOT do

No prod EC2 app-host, no Caddy, no `aws-prod.toml`, no Nexus/Synapse/suite prod, no gateway (`gateway.ctxhost.com`), no provider-credential BYO in prod, no tenant wildcard hosts. All of that stays on the ADR-075/113 full-suite track, untouched and unblocked.

## Decisions — LOCKED (Roland, 2026-07-13; all four as recommended)
1. **Postgres: Option B** — provisioned `db.t4g.micro`/`small` multi-AZ + RDS Proxy (revisit Aurora Sv2 only if traffic warrants).
2. **JWT: RS256 + JWKS at launch** — Engram-prod holds the only private key; tradepost-prod verifies via JWKS and can never mint.
3. **Cookies: host-only on `login.ctxhost.com` + PKCE** — the `.ctxhost.com` apex SSO cookie is deferred to full-suite prod.
4. **Phase-1 OpenNext spike: GREENLIT** — worker-b authors in wave-18; controller deploys the throwaway stack locally.

These are settled — the implementing agent must not re-litigate them. Wave-18 launch is unblocked.

---

## Addendum (2026-07-13): WorkOS alternative — evaluated and REJECTED (Roland decision)

Roland raised migrating tradepost to WorkOS (hosted consumer auth, free ≤1M MAU) in place of the Engram-prod prerequisite. Evaluated honestly: it would ship tradepost-prod faster and cheaper **if tradepost were a standalone consumer product**. Roland then settled the product question: **tradepost is a suite citizen** — CORTEX agents will help manage users' collections, and guilds/playgroups are on the roadmap.

That makes the rejection unambiguous:
1. **Guilds/playgroups ARE org tenancy** — membership, roles, invites: Engram's core schema, already built. WorkOS would force re-implementing orgs app-side within the roadmap's horizon.
2. **Agent integration needs platform identity** — cortex agents acting on a user's collection require the suite's identity/authz surface (the ADR-022-class internal APIs), not a third-party consumer-auth session.
3. **Key-space stickiness**: whoever mints tradepost-prod's first real user IDs owns `USER#<id>` forever (DynamoDB single-table). Minting them in Engram from day one is the whole ballgame; migrating identities after launch is the expensive path.

Decision: **Engram-prod remains the tradepost-prod prerequisite.** The four open decisions above (§Open decisions) are unchanged and remain Roland's gates.

---

## Addendum (2026-07-13): per-client branded auth pages + signup policy — APPROVED workstream

Roland: the stock Engram login page shouldn't be what tradepost users see. Approved approach (Auth0/Clerk-style **per-client branded auth**, NOT client-hosted forms):

- **Pages stay on Engram's origin** (`login.ctxhost.com` / dev equivalent) — credentials are only ever typed on the IdP origin (anti-phishing, no credential surface spread), OAuth callbacks and magic-link/recovery emails keep working unmodified.
- **Theming is keyed off the PKCE `client_id`** already present in the `/authorize` flow: add branding fields to the `NativeAuthClient` registry (logo, palette, product name, background) and render login / create-account / recovery in the client's skin ("Sign in to Tradepost", optional "secured by Engram" footer).
- **Per-client signup policy** (the bigger functional gap): Engram's self-service registration is deliberately waitlist-gated for the suite, but public tradepost-prod needs real "create account." Policy becomes per-client: the `tradepost-web` client allows self-serve signup minting identity-only users (no org); suite clients stay waitlist-gated. Small ADR + registry migration (migration = human-approval gate per suite guardrails).
- **Scheduling**: a wave-18 track buildable and verifiable on aws-dev immediately (against `tradepost.dev.ctxhost.com`), independent of the prod-infra phases — can run in parallel with the Phase-1 OpenNext spike.

### CDK ownership note (for the wave-17 docs true-up)

Both engram and cortex repos currently carry copies of the shared platform stacks (network/data/app/dns) in their CDK apps; cortex's copy is the fuller one (adds bridge-stack) and cortex's charter is "shared hosted platform infra." Line going forward: **cortex owns shared platform CDK; engram's duplicate copy is drift to retire (on paper first); each serverless app owns its app-scoped stacks in-repo** — tradepost today, and the new `engram-prod-{cert,data,web,ops}` stacks land in the engram repo per Phase 2 of this plan.
