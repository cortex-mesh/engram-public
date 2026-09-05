# ADR-031: Refresh-token reuse-grace window

**Status:** Accepted (2026-07-22)

**Amends:** ADR-001 (session/token model — refresh-token rotation & reuse detection). Implements the deferred "audit #7 follow-up" from `docs/security-audit-2026-05-20.md` §7 and `docs/security-audit-2026-06-10-gate-verification.md` (Remaining open items).

## Context

Engram issues a 15-minute access token + a 30-day **single-use** refresh token; the refresh token is DB-backed (`RefreshToken.tokenHash`, SHA-256; **raw tokens are never stored**). Rotation is atomic single-winner (ADR-001 + audit-#7 PR #99): the presented token's row is consumed and a successor row created in one `$transaction`; if the presented token is not the active one, the **entire token family is revoked** (`deleteMany({ userId })`) as a theft signal.

That family-revoke is too aggressive for a **benign concurrent refresh**, which is common and not theft:

- A browser whose 15-min access token has just expired fires several requests at once (multiple tabs, link prefetch, React Server Component requests). Each carries the same refresh token and races to rotate it.
- First-party clients coalesce concurrent refreshes, but only **per process/instance** (e.g. Tradepost's `middleware.ts` in-memory cache is per-Lambda-container). Across instances — and maximally right after a client **deploy**, when every warm instance is replaced by cold ones with empty caches and a CDN cache-invalidation drives a cold-start burst — two requests holding the same refresh token land on different instances and each rotate it. The second is seen as reuse → **the family is revoked → the user is logged out.**
- A retry after a network timeout that occurred *after* Engram already rotated server-side has the same effect.

Symptom in production: users are logged out on **every** client deploy and intermittently otherwise. This is a false-positive of reuse detection, not token theft.

## Decision

Add a short **reuse-grace window**: a refresh token that was **rotated within the last `GRACE_WINDOW` (30 s)** is treated as a benign concurrent/retry refresh — the caller is issued a fresh valid pair instead of having the family revoked. Genuine reuse (a consumed token presented *after* the window, or an unknown token) still revokes the family, preserving theft detection.

### Mechanism — idempotent grace via an encrypted successor

The grace must be **idempotent**: every concurrent/retry presentation of the same token must receive the **same** successor, so there is exactly one forward chain. (Minting a *fresh* token per graced caller was considered and rejected — it forks an independent chain, which lets a token thief racing the window keep a silent parallel session that reuse detection would never reconcile.) Returning the same successor requires remembering it briefly; we do so **encrypted**, so raw tokens are still never stored in plaintext.

1. **Schema** — `RefreshToken` gains nullable `consumedAt DateTime?` (+ index) and `replacement String?` (the AES-256-GCM-encrypted successor refresh token). Rotation **keeps** the old row and stamps both, instead of deleting it.
2. **Atomic single-winner rotation (preserved)** — rotate with a conditional `updateMany({ where: { tokenHash, consumedAt: null }, data: { consumedAt: now, replacement: encrypt(successor) } })`; exactly one concurrent caller flips `null → now` (`count === 1`) and wins, then creates the successor row in the same transaction — same one-winner guarantee as the delete-based version (audit #7), via a conditional update.
3. **Grace branch** — a caller that did **not** win looks the presented token up:
   - row exists, has a `replacement`, and `now − consumedAt ≤ GRACE_WINDOW` → **graced**: decrypt the stored successor and return it, paired with a freshly-minted access token. Every within-grace caller returns the **same** successor → one chain, no fork, no new row. A low-severity `refresh.reuse_graced` audit event is emitted for monitoring.
   - otherwise (consumed outside the window, no recoverable successor, or the row is gone) → **reuse**: revoke the family + emit `refresh.reuse_detected`, as today.
4. **Encryption key** — the AES key is derived (scrypt) from the environment's deploy-stable JWT **signing material**, so a successor encrypted on one instance decrypts on another and no new secret is introduced. Engram runs two JWT modes and the material differs by mode, so the material is selected by the **configured algorithm** — the same `ENGRAM_JWT_ALGORITHM` switch `jwt.ts` uses: RS256 → `ENGRAM_JWT_PRIVATE_KEY` (aws-prod), HS256 → `ENGRAM_JWT_SECRET` (dev/on-prem), failing only if the mode-required material is absent in production. (Keying off `ENGRAM_JWT_SECRET` alone 500'd the aws-prod refresh path on 2026-07-22 — prod is RS256 and has no symmetric secret; see the amendment below and `docs/incidents/2026-07-22-refresh-grace-prod-500.md`.) A rotated encrypted value is unrecoverable after a signing-key rotation (which already invalidates all sessions).
5. **Cleanup** — after a successful rotation, delete the user's own rows consumed **past the grace window** (`consumedAt < now − GRACE_WINDOW`), so "row present" and "graceable" coincide: a consumed row that still exists is always within grace. This deliberately avoids a dead band (a present-but-ungraceable row would mis-classify a benign retry as reuse) and bounds table growth, dropping the encrypted successor once it can no longer be graced. (A razor-thin race remains where a retry's read lands in the ~ms after a concurrent rotation's sweep commits at the exact window boundary; it only affects a token already at the stale edge.)

The rotation+grace logic and the family-revoke (`revokeTokenFamily`) are one shared helper (`src/lib/refresh-rotation.ts`) used by both rotation sites — `/api/auth/refresh` (JSON/native) and `/api/auth/continue` (browser SSO) — which previously carried duplicated logic (and the SSO path revoked without an audit event; now fixed).

### Trade-offs

- **Theft within the window:** a stolen refresh token replayed within 30 s of a legitimate rotation is graced onto the *same* chain rather than revoked — the inherent, accepted cost of any grace window, bounded to 30 s, still rate-limited (60/min/IP), emitting `refresh.reuse_graced` telemetry, and with reuse *outside* the window still caught. Crucially, idempotency means it does **not** create an independent parallel session. Short-lived access tokens continue to bound blast radius (ADR-001).
- **Brief encrypted token-at-rest:** the successor is stored (AES-256-GCM, key derived from the environment's JWT signing material — see mechanism §4) for ≤ 2× the grace window, then swept. This is a small, time-boxed relaxation of "raw tokens never stored" (ciphertext only, never plaintext) accepted to gain idempotency; the alternative (fresh-token-per-caller) was the worse security posture.
- **Reduced false-positive theft alerts:** benign concurrent refreshes no longer emit `refresh.reuse_detected` (they emit the lower-severity `refresh.reuse_graced`), so the reuse-detected signal becomes higher-fidelity.
- **Late-straggler limit (inherent):** a refresh presented *more than* `GRACE_WINDOW` after its rotation — a tab backgrounded for a minute, a mobile radio wake, a proxy retry — still revokes the family. Any refresh-rotation-with-reuse-detection scheme has this edge: there is no window that admits every benign late retry without also being an exploitable replay window for a thief. 30 s covers the common concurrent/deploy burst (the reported problem); the residual is observable via `refresh.reuse_graced` volume and could be widened later if telemetry shows real pain. Making it fully painless would require softening the theft posture (reject-the-request instead of revoke-the-family), a separate decision.

## Consequences

- Additive, backward-compatible migration (one nullable column + index) — existing rows/sessions are unaffected (`consumedAt` defaults null = active). Prod migration remains **human-gated** (private RDS; one-shot bastion per `docs/runbooks/prod-db-migration-verify-apply.md`).
- Applies to all Engram OAuth clients (Tradepost, nexus, synapse, pulse, plexus…) — the fix lives at the IdP, not per app. Tradepost's per-instance coalescing cache stays as cheap belt-and-suspenders but is no longer load-bearing.
- Reuse-detection invariant in `docs/runbooks/security-audit.md` and `docs/architecture-audit.md` is refined (revoke on reuse **outside the grace window**); the audit-#7 follow-up is closed.

## Amendment (2026-07-22) — encryption key material spans both JWT modes

**Context:** the original implementation derived the successor-encryption key **only** from `ENGRAM_JWT_SECRET`. That variable exists in HS256 environments (dev/on-prem) but **not** in aws-prod, which signs with RS256 (`ENGRAM_JWT_PRIVATE_KEY`). Deploying the fix therefore 500'd the prod refresh/login path (`encryptSecret` threw its production guard), while CI and dev stayed green because they set the symmetric secret. Postmortem: `docs/incidents/2026-07-22-refresh-grace-prod-500.md`.

**Decision:** the key material is selected **by the configured JWT algorithm** (`ENGRAM_JWT_ALGORITHM`, mirroring `jwt.ts:getJwtAlgorithm`) — RS256 → `ENGRAM_JWT_PRIVATE_KEY`, HS256 → `ENGRAM_JWT_SECRET`. **`encryptSecret`** uses the mode's key (hard-failing in production if that material is absent), so new values migrate forward onto the canonical per-mode key. **`decryptSecret`** tries any present JWT material (mode key first, then the other var). Selecting encrypt by algorithm rather than a `SECRET || PRIVATE_KEY` presence-fallback is deliberate: in RS256 the symmetric secret is **ignored for encryption** even when present, so the temporary interim secret's later removal cannot change the encryption key. The transition-tolerant *decrypt* additionally lets a value encrypted under one valid key still be read while a second valid key is present — bridging the mitigation→private-key cutover without misclassifying a benign in-grace refresh as reuse. Both materials are deploy-stable and already required for JWT signing, so "no new secret introduced" holds in both modes. Guardrails: `tests/lib/crypto.test.ts` covers the aws-prod round-trip (RS256, no `ENGRAM_JWT_SECRET`), that dropping a co-present interim secret in RS256 leaves the encryption key unchanged, and that a token encrypted under the interim secret still decrypts after the cutover.

**Prod interim state:** a temporary `ENGRAM_JWT_SECRET` Lambda env var was set on `engram-prod-web` to restore service. The fix deploy is seamless — decrypt still recovers pre-cutover in-grace successors via the interim secret (which remains on the Lambda at cutover), so no family-revoke is triggered. Remove the interim var in a **later** deploy (not the cutover deploy): once the fix is live, encryption no longer uses it and after one grace window no live ciphertext depends on it. See `docs/incidents/2026-07-22-refresh-grace-prod-500.md`.
