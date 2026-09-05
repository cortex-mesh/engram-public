# Incident — Refresh-grace deploy 500'd prod login (2026-07-22)

**Severity:** high (prod login broken for re-authenticating users) · **Duration:** ~code-deploy → mitigation (single-digit minutes of active errors) · **Surface:** `auth.ccgtradepost.com` (`engram-prod-web`) · **Author:** Roland + controller session

## Summary

Deploying Engram **0.52.3** to aws-prod (the ADR-031 refresh-token reuse-grace fix) caused `/api/auth/continue` and `/api/auth/refresh` to return **HTTP 500** for any user whose 15-minute access token had expired (i.e. the login/refresh path). The new code called `encryptSecret`, whose key is derived from `ENGRAM_JWT_SECRET` — a variable that **does not exist in aws-prod**, because prod signs JWTs with RS256 (asymmetric keys), not HS256. It threw `ENGRAM_JWT_SECRET must be set in production` inside the rotation transaction.

The bug passed CI and dev because **dev/on-prem run HS256 and have `ENGRAM_JWT_SECRET` set** — the environment divergence masked it.

## Timeline (UTC, 2026-07-22)

- Migration 0021+0022 applied to prod RDS (additive, human-gated bastion) — fine.
- `Deploy Engram Prod` (web stack) → prod on 0.52.3.
- `~17:48–17:49` `/api/auth/continue` 500s observed; logs show repeated `Error: ENGRAM_JWT_SECRET must be set in production` from `_transactionWithCallback` (the rotation).
- **Mitigation:** set `ENGRAM_JWT_SECRET` as a prod Lambda env var (merged into the existing env, not replacing it). Safe because prod's RS256 path never reads it (see Root cause). Prod recovered — continue path returns 307, **0 errors** thereafter.

## Root cause

Two independent facts combined:

1. **Dev and prod sign JWTs in different modes.** `getJwtAlgorithm()` (`src/lib/jwt.ts`) reads `ENGRAM_JWT_ALGORITHM`: dev/on-prem = **HS256** (uses the symmetric `ENGRAM_JWT_SECRET`); aws-prod = **RS256** (uses `ENGRAM_JWT_PRIVATE_KEY`/`ENGRAM_JWT_PUBLIC_KEY`). In prod, `getJwtSecret()` — the only reader of `ENGRAM_JWT_SECRET` — is **never called**, so prod legitimately has no `ENGRAM_JWT_SECRET`.
2. **The new code introduced a hard dependency on that variable on a hot path.** ADR-031's `encryptSecret` (`src/lib/crypto.ts`) derived its AES key solely from `ENGRAM_JWT_SECRET` and threw in production if absent. The old refresh path never called `encryptSecret`, so this dependency was brand-new and only exercised on a *winning* rotation.

## Why verification missed it

- **CI/dev could not catch it:** dev sets `ENGRAM_JWT_SECRET` (HS256), so `encryptSecret` always had a key. No test ran in prod's RS256 / no-symmetric-secret configuration.
- **Post-deploy smoke check didn't reach the failing code:** the initial prod check was `/api/health` + a bogus-refresh-token request returning 401. A bogus token never *wins* a rotation, so it never called `encryptSecret`. Liveness looked green while real logins were broken.

## Fix (forward)

`encryptSecret` selects its key material by the **configured JWT algorithm** — the same switch `jwt.ts` uses — rather than a presence-order fallback: RS256 → `ENGRAM_JWT_PRIVATE_KEY`, HS256 → `ENGRAM_JWT_SECRET`; it hard-fails in production only if the mode-required material is absent (`src/lib/crypto.ts`; ADR-031 amended). **Encrypt** always uses the mode's key (new values migrate forward), while **decrypt** tries any present JWT material (mode key first, then the other var). Regression tests cover the prod-mode round-trip, that dropping the co-present temp secret in RS256 leaves the key unchanged, and that a token encrypted under the interim secret still decrypts after the private-key cutover (`tests/lib/crypto.test.ts`).

**Cleanup guidance (corrected):**
- **The fix deploy is seamless.** The *currently deployed* mitigation keys off the temp secret; the fixed code keys off the private key. Because decrypt tries the interim secret too (it is still on the Lambda at cutover), a successor encrypted just before the deploy still decrypts afterward — so a benign in-grace refresh is **not** misread as reuse. (Without this, an undecryptable in-grace successor routes to `revokeTokenFamily` — a full multi-device session-family revoke plus a false `refresh.reuse_detected` alert, not merely "one extra login" — which is why decrypt is transition-tolerant by design.)
- **Remove the temporary `ENGRAM_JWT_SECRET` in a *later* deploy, not the cutover deploy.** Once the fix is live, encrypt no longer uses the interim secret, so after one grace window (~30 s) no live ciphertext depends on it and the var can be dropped safely (RS256 keys off the private key; verified by test). Removing it in the *same* deploy as the cutover would delete the only key that decrypts pre-cutover in-grace tokens — so sequence it after.
- **Until #198 lands on prod the temp env var is load-bearing:** a `cdk deploy` of `engram-prod-web` that predates this fix would revert the env and re-break prod. The fix must land before any such deploy.

## Prevention / follow-ups

1. **Done:** RS256/prod-mode unit coverage for `encryptSecret` (would have failed CI on this change).
2. **Recommended — automated post-deploy prod auth smoke test:** wire a real login→refresh round-trip against `auth.ccgtradepost.com` into `Deploy Engram Prod`, failing the deploy if the auth flow 500s. Highest-value guardrail; needs a dedicated prod test account (operator decision).
3. **Recommended — run the auth suite in both JWT modes** (HS256 *and* RS256) in CI, so any future prod-mode-only dependency is caught pre-merge.
4. **Recommended — per-environment required-env manifest** validated at deploy time, so "new code needs a var this environment lacks" fails loudly instead of at runtime.

## Lessons

- **"Green on dev + tests" ≠ "works on prod"** whenever behavior depends on env that diverges by environment — here the JWT mode (HS256 vs RS256). Any code touching JWT/secret/crypto env must be proven against **both** modes.
- **Post-deploy verification must exercise the actual changed code path**, not just endpoint liveness. Pick a check that reaches the new logic (a real rotation), or it can pass while the feature is broken.
