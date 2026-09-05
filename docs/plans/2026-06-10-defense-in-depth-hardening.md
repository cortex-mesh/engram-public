# Defense-in-Depth Hardening — Engram

**Date:** 2026-06-10
**Status:** ✅ Complete — D1–D7 all shipped, deployed, and verified on both envs 2026-06-10 (PRs #99–#104).
**Scope:** The seven remaining security-audit items that are **entirely within
Engram** (no consumer/contract change). Derived from
`docs/security-audit-2026-06-10.md` and its gate-verification follow-up. The
external-tenant hard gate (HG-1..HG-4) is already verified closed; these are
defense-in-depth — none gate a pilot tenant.
**Related:** `docs/security-audit-2026-06-10-gate-verification.md`,
`docs/adr/ADR-017-oauth-only-set-password-flow.md` (set-password design).

## Why these can stay in-repo

Verified against the sibling repos (2026-06-10): no consumer or native client
references magic-link, password-setting, or the change-password endpoint;
none call `/api/auth/refresh` or `/api/auth/token` server-side. synapse-native
*does* use `/api/auth/token` + `/api/auth/refresh` (native PKCE), so the one
discipline is that **#7 must not change the refresh/token request/response
contract** — it is a pure internal transaction wrapper. Everything beyond
Engram + (potentially) synapse-native would be flagged before starting.

## Items

Each ships as its own PR (plan → implement+test → review → merge on green),
smallest/lowest-risk first; the set-password flow last, after its ADR.

### D1 — #7 Refresh-token rotation is not atomic (MEDIUM)
- **Now:** `src/app/api/auth/refresh/route.ts` and the rotation half of
  `continue/route.ts` do `findFirst` → `delete` → `create` as separate
  statements. Concurrent refreshes can race (avoidable logout / confusing
  reuse signals).
- **Fix:** make consume-old + create-new atomic. Prefer a conditional
  `deleteMany({ where: { id, ... } })` and require `count === 1` before
  issuing the new token, inside a `$transaction`. **No response-shape change**
  (native contract preserved).
- **Size:** S.

### D2 — #9 Privileged routes trust the JWT role claim (MEDIUM)
- **Now:** `authenticateRequest` returns `role` straight from the 15-min
  access token; the 10 admin/orgs routes authorize on `auth.role`. A demoted
  superadmin keeps platform privileges until the token expires.
- **Fix:** a `requireCurrentPlatformSuperadmin(request)` helper that
  re-reads the user's current role from the DB after token verification, used
  by the platform-superadmin routes. Org-manager checks already re-read
  `OrgMember.role` from the DB, so they're unaffected.
- **Scope note:** this closes the gap **for Engram's own privileged routes**.
  Making role changes propagate instantly to *consumers* (which trust the JWT
  role claim) is a separate, cross-repo `tokenVersion`/session-version effort
  and is explicitly out of scope here.
- **Size:** S–M.

### D3 — #12 Authorization-critical roles are free-form strings (MEDIUM)
- **Now:** `User.role`, `OrgMember.role`, `OrgInvite.role` are `String` in
  `prisma/schema.prisma`; only app code constrains them.
- **Fix:** Prisma enums (Postgres enums via migration). `PlatformRole`
  (`USER`, `SUPERADMIN`) and `OrgRole` (`OWNER`, `ADMIN`, `MEMBER`), values
  per ADR-005 and confirmed against live data. **Pre-check:** live role data
  is clean on aws-dev (User: SUPERADMIN/USER; OrgMember: OWNER/ADMIN/MEMBER;
  OrgInvite: none) — re-confirm on-prem before the migration so the enum cast
  can't fail.
- **Size:** M (migration + generated-type churn).

### D4 — N-5 Magic-link verify consumed on GET (LOW/MEDIUM)
- **Now:** `magic-link/verify` GET consumes the token and mints a session
  directly; an email link-scanner/prefetch burns valid links.
- **Fix:** the GET renders a minimal interstitial ("Continue to sign in")
  whose POST performs the consumption + session mint. Scanners issue GET and
  don't execute the POST, so links survive prefetch. Also closes the
  session-minting-on-GET login-CSRF window.
- **Size:** S–M.

### D5 — #11 Docker image runs as root (MEDIUM)
- **Now:** the runner stage has no `USER`; any RCE runs as root.
- **Fix:** run as the built-in non-root `node` user — chown the app dir,
  `USER node` before `ENTRYPOINT`. Must keep the one-shot `prisma migrate
  deploy` hook working (it reuses this image; prisma writes to the DB + /tmp,
  not the app dir). Verify the container + migration hook still run on aws-dev
  + on-prem.
- **Size:** S.

### D6 — `brace-expansion` dependabot advisory (LOW, dev-tooling)
- **Now:** one open advisory in the eslint/minimatch chain (dev-only).
- **Fix:** lockfile bump to a patched `brace-expansion`. No runtime impact.
- **Size:** XS. (Bundled with D5 as one ops-hygiene PR.)

### D7 — Verified-email set-password flow (new, per ADR-017)
- **Now:** OAuth-only accounts 409 on change-password (HG-3) with no
  supported way to gain a password.
- **Fix:** a purpose-tagged magic-link flow that proves email control *at the
  moment of setting* — design in **ADR-017**. Largest item; ships last.
- **Size:** L.

## Tasks
- [x] D1 refresh rotation atomic (+ continue) — PR #99
- [x] D2 DB role re-read on platform routes (`isCurrentPlatformSuperadmin`) — PR #100
- [x] D3 role enums migration (data re-confirmed on both envs; in-place cast) — PR #101
- [x] D4 magic-link interstitial — PR #102
- [x] D5+D6 Docker non-root + aws-cdk-lib bump (brace-expansion bundled in cdk) — PR #103
- [x] D7 set-password flow (per ADR-017) — PR #104
- [x] Verify each: typecheck + lint + test; deploy + health-check both envs.

## Progress log
| Date | Update |
| --- | --- |
| 2026-06-10 | Plan + ADR-017 created. All seven confirmed Engram-only against the sibling repos. |
| 2026-06-10 | **All seven shipped, deployed, and verified on aws-dev + on-prem.** D1 atomic refresh (#99); D2 DB role re-read across 12 routes/lib (#100); D3 role enums via hand-written in-place-cast migration (#101) — surfaced + cleared a full-disk on the aws-dev EC2 host (122GB docker build cache + 56GB stale images pruned, infra not code); D4 magic-link GET interstitial (#102); D5 non-root `node` container + D6 aws-cdk-lib 2.250→2.258.1 (brace-expansion/fast-uri were bundled in aws-cdk-lib) (#103); D7 set-password flow (#104), live-smoked. No change beyond Engram (synapse-native untouched). |
