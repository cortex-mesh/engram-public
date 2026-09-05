# Runbook — Engram Security Audit

How to run a repeatable security audit of Engram, the identity root for the
hosted suite. Each audit produces a dated findings doc
(`docs/security-audit-YYYY-MM-DD.md`) that records the status of every prior
finding plus anything new, with severity and remediation priority. Audits do
**not** fix anything — remediation is planned separately (see
`docs/plans/2026-05-31-security-hardgate-remediation.md` for the active gate).

## When to run

- Before any milestone that puts new external-customer data on the shared
  suite (hard gate — see the remediation plan).
- After any change to the auth surface: `src/lib/{jwt,auth,native-auth,cors,
  auth-redirect,organizations,user-app-entitlements}.ts`, anything under
  `src/app/api/auth/`, `src/app/api/admin/`, `src/app/api/orgs/`, cookie or
  JWT contract changes, or Dockerfile/deploy-manifest changes.
- Otherwise quarterly.

## Inputs

Read these first so the pass verifies rather than rediscovers:

- The most recent `docs/security-audit-YYYY-MM-DD.md` (prior findings + status).
- `docs/plans/2026-05-31-security-hardgate-remediation.md` (what is gated/in flight).
- `docs/suite-auth-consumer-audit-2026-05-20.md` (which contract changes are safe).
- ADR-013 (browser SSO cookie + CSRF contract), ADR-001 (identity service).

## Procedure

### 1. Re-verify prior findings

For every finding in the latest dated audit doc, read the current code at the
evidence locations (line numbers drift — search for the construct, don't trust
line numbers) and assign a status:

- **OPEN** — still as described, with current `file:line` evidence.
- **FIXED** — describe the fix, link the commit/PR.
- **PARTIAL** — what changed, what remains.

Also run `git log --oneline --since=<last-audit-date> -- src/ prisma/
Dockerfile .github/workflows/` and note any security-relevant commits.

### 2. Code review areas

Work through each area below. For each, record concrete findings with
`file:line` evidence, or explicitly mark it **clean** (a clean verdict is a
result too — it tells the next audit what was already probed).

**Authentication & session**
- Password verification: dummy-hash compare for unknown users (timing
  enumeration), bcrypt cost, 72-char truncation guard.
- JWT sign/verify (`src/lib/jwt.ts`): algorithm pinning, issuer/audience,
  token TTLs, secret guards.
- Refresh rotation (`api/auth/refresh` + `api/auth/continue`, shared
  `lib/refresh-rotation.ts`): atomicity under concurrent refresh, the ADR-031
  reuse-grace window (a token rotated within ~30 s is graced, not revoked),
  reuse detection revoking the session family *outside* the window, token type
  enforcement.
- Cookie attributes: httpOnly/secure/SameSite, set vs. clear parity
  (domain/path must match on logout), refresh-cookie path scoping.
- Magic links: hashed at rest, single-use atomic consumption, TTL, GET vs.
  POST consumption (scanner prefetch), send throttling.

**CSRF & browser surface**
- Every cookie-authenticated unsafe method must have CSRF protection; check
  routes added since the last audit. Note `hasCrossOriginCookieWrite()`
  fail-open behavior when `Origin` is absent.
- Security headers: `next.config.ts` `headers()` / middleware — HSTS, CSP,
  `X-Frame-Options`/`frame-ancestors`, `nosniff`, `Referrer-Policy`.
- `Cache-Control: no-store` on token-bearing and account responses
  (`login`, `refresh`, `token`, `users/me`).
- CORS (`src/lib/cors.ts`): trusted-origin computation stays an exact
  allowlist; `Vary: Origin` present.

**Redirect & URL derivation**
- `src/lib/auth-redirect.ts`: re-probe `//evil.com`, `/\evil.com`,
  userinfo (`https://host@evil.com`), suffix tricks
  (`tenant.root.evil.com`), encoded slashes; reserved-subdomain list still
  covers all platform hosts.
- Public-origin derivation (`src/lib/public-origin.ts` + magic-link/OAuth
  callers): `ENGRAM_URL` must win; flag any Host/X-Forwarded fallback
  reachable in production.

**OAuth & native PKCE**
- OAuth linking: provider email verified before linking
  (`email_verified` for Google, `/user/emails` primary+verified for GitHub);
  state cookie CSRF; callback redirect validation.
- Native PKCE (`src/lib/native-auth.ts`, `/authorize`, `api/auth/token`):
  atomic single-use code consumption, code bound to client_id + redirect_uri,
  S256 only, timing-safe verifier compare, fixture-endpoint gating.

**Tenancy & authorization**
- IDOR sweep on every `[orgId]`/`[userId]` route: target-membership checks,
  404 (not 403) for non-members, entitlement gates
  (`ensureOrgHasAppEntitled`).
- Privileged routes: role re-read from DB vs. trusting the 15-min JWT claim.
- Internal API key: timing-safe compare, denied on user/org management,
  never logged.
- Mass assignment on PATCH routes (explicit field allowlists only).

**Abuse resistance**
- Rate limiting / lockout on `login`, `refresh`, `magic-link`, `token`.
- Account-enumeration oracles (response bodies, status codes, timing).

**Operational**
- Audit logging: are login success/failure, password change, admin actions,
  role/entitlement changes recorded?
- Secrets in logs: grep `console.` across `src/` and `scripts/` for token/
  password/secret values.
- Dockerfile: non-root `USER`, minimal runtime files.
- Prisma schema: enums/constraints on authorization-critical fields.

### 3. Dependency audit

```bash
npm audit --omit=dev
```

Record the `next` version and any advisory with a fix available. Framework
advisories are high priority on a public auth surface.

### 4. Deployed configuration

Check both live environments. **Never dump the full container env** — it
contains `ENGRAM_JWT_SECRET` and OAuth secrets. Grep only the keys below and
report secret-bearing keys as set/unset.

Keys: `ENGRAM_URL` (must be set, https, canonical), `ENGRAM_COOKIE_DOMAIN`,
`ENGRAM_ALLOWED_ORIGINS`, `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE` (**must be
unset/0 anywhere external users exist; never on aws-prod**), `NODE_ENV`
(production), `ENGRAM_INTERNAL_API_KEY` (set/unset only).

On-prem (on-prem-host):

```bash
ssh rocky@localhost 'docker exec engram sh -c \
  "env | grep -E \"^(ENGRAM_URL|ENGRAM_COOKIE_DOMAIN|ENGRAM_ALLOWED_ORIGINS|ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE|NODE_ENV)=\""'
```

aws-dev (SSM via the `cortex` profile; app host is the EC2 instance named
`cortex-dev-app-host`):

```bash
AWS_PROFILE=cortex aws ssm send-command --region us-west-2 \
  --instance-ids <cortex-dev-app-host instance id> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["grep -E \"^(ENGRAM_URL|ENGRAM_COOKIE_DOMAIN|ENGRAM_ALLOWED_ORIGINS|ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE|NODE_ENV)=\" /opt/cortex/apps/engram/.env"]'
# then: aws ssm get-command-invocation --command-id <id> --instance-id <id>
```

Also confirm port 3104 is not directly reachable from outside the host
(the `/api/internal/tls/allow` loopback check trusts the Host header).

### 5. Suite consumer impact

Before recommending any fix that touches shared contracts (JWT claims/alg,
cookie names/domain/path, login/refresh JSON shape, CSRF token requirements),
check `docs/suite-auth-consumer-audit-2026-05-20.md` and mark the finding
"requires consumer rollout". Engram-local fixes should not silently break
Nexus/Synapse/Thoughts/Pulse/Plexus.

### 6. Write the findings doc

Create `docs/security-audit-YYYY-MM-DD.md` containing:

1. Summary + verdict.
2. Deployed-config results per environment.
3. Prior-findings status table (OPEN/FIXED/PARTIAL with evidence).
4. New findings, each with severity, evidence, impact, recommended fix,
   consumer impact.
5. Clean areas (what was probed and passed).
6. Prioritized remediation queue, reconciled with the hard-gate plan —
   update that plan's progress log with a one-line pointer to the new audit.

### Severity rubric

- **HIGH** — tenant-isolation break, auth bypass, credential/token theft
  path, or unthrottled abuse of a public auth endpoint.
- **MEDIUM** — meaningful hardening gap with a realistic path to impact
  (enumeration oracle, missing headers, role-claim staleness, root
  container), or a HIGH mitigated by deployment topology.
- **LOW** — defense-in-depth or information-leak nits.
- **INFO** — not currently exploitable; track for design completeness.

## History

| Date | Doc | Notes |
| --- | --- | --- |
| 2026-05-20 | `docs/security-audit-2026-05-20.md` | Initial audit (Hermes), 15 findings; spawned the hard-gate remediation plan. |
| 2026-06-10 | `docs/security-audit-2026-06-10.md` | First runbook-driven pass; 14/15 prior findings still open; 7 new findings incl. fixture flag enabled on aws-dev. |
| 2026-06-10 | `docs/security-audit-2026-06-10-gate-verification.md` | Post-remediation verification (PRs #90–95). Gate HG-1..HG-4 CLOSED; found + fixed `users/me` PATCH CSRF gap (HG-3 was PARTIAL). N-1..N-4 fixed. |
