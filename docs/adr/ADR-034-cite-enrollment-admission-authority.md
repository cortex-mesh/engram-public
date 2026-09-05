# ADR-034: Cite Enrollment as a Signed, Axon-Only Admission Authority

**Status:** Accepted (2026-07-31)

**Relates to:** ADR-005 (org roles + app entitlements) · ADR-009 / ADR-030 (per-user and per-member app access) · ADR-010 (consumer app admission pattern) · ADR-027 (consumer-client admission via designated-org auto-join) · ADR-014 / ADR-025 (JWT signing keys — deliberately **not** reused here) · ADR-022 (internal-service guard — deliberately **not** reused here). Consumer contract: [`docs/contracts/cite-enrollment/v1.openapi.json`](../contracts/cite-enrollment/v1.openapi.json). Operations: `docs/runbooks/cite-production-auth-preparation.md`, `docs/runbooks/enrollment-signing-secret-provisioning.md`.

## Context

"Cite the Move" is the public presentation of the first-party `axon-web` client — brand metadata only (migration `0025`); the client id, `axon` app binding, and callback registrations are unchanged. Cite must admit a _subset_ of authenticated Engram users to a limited product surface and withdraw that admission promptly and provably.

Engram already has three admission mechanisms. None of them fits:

- **Org membership + `OrgAppEntitlement`** (ADR-005) answers _tenancy_: "does this org get app X". Cite users are consumer accounts arriving through designated-org auto-join (ADR-027); their org membership is an artifact of self-serve signup, not an admission decision.
- **`UserAppEntitlement` / `accessMode`** (ADR-009, ADR-030) is a per-org allow/deny list read from those same tenancy tables and surfaced to apps as one boolean on `/api/orgs`. It is unsigned, computed at read time inside the IdP, and keeps no history — a consumer can neither prove what Engram said nor prove it saw every change.
- **Access-token claims** are verified locally and live 15 minutes, so a revocation is invisible for up to a token lifetime and leaves no consumer-side record that it arrived.

Cite needs an admission decision that (a) is provably Engram's, (b) is **ordered** — the consumer can prove it has seen every mutation, (c) survives consumer-side state loss, and (d) is **deny-by-default** whenever the consumer cannot establish current state. That is an authority with its own signed, replayable state, not another column read through the tenancy model. Conflating the two would also mean any future change to org or entitlement semantics silently moves a paid admission boundary.

The second constraint is blast radius. Engram is now a shared IdP: one production deployment serves `login.ctxhost.com`, Tradepost's `auth.ccgtradepost.com`, and the hosted suite. Cite is one client among many, and on aws-prod Engram runs on Lambda, so anything on the startup path executes at **every cold start**. Any Cite-specific fault — missing key material, a lapsed validity window, a problem on the enrollment tables — must degrade Cite and nothing else.

## Decision

### 1. Enrollment is a first-class authority, disjoint from tenancy

`Enrollment` is keyed by `(clientId, subjectId)` where `subjectId` is the Engram `User.id` — never email, never a membership row. It carries `status` (`active` / `revoked` / `expired`), a monotonic `version`, a required future `expiresAt`, and revocation metadata. Nothing in the org, membership, entitlement, session, or UI model participates in the decision, and enrollment participates in none of them: a user may be an org OWNER with `axon` entitled and still be unenrolled, and the reverse.

`Enrollment.userId` is `onDelete: Restrict`. Engram refuses a physical identity deletion while enrollment history exists, rather than risk leaving a live signed admission assertion for a deleted identity. The controller must revoke and deprovision admission explicitly; historical evidence is retained.

**Only an active, unexpired, unrevoked assertion signed by Engram is an allow.** Absence, any validation failure, or unreadable acknowledged state is a deny. Consumers must not import Engram code or infer enrollment from anything else.

### 2. One Axon-only client scope, selected by the credential

The contract represents exactly one client, `axon-web`, and one consumer, `axon`. `/api/internal/enrollment/v1/*` authenticates a **dedicated** machine credential (`ENGRAM_AXON_ENROLLMENT_API_KEY`, constant-time compared) — never a browser cookie, user JWT, or the shared `ENGRAM_INTERNAL_API_KEY` of ADR-022, so revoking Cite's read access does not revoke cortex's owner-lookup access or the reverse.

Scope comes from the authenticated binding, not the request: a `client_id` query parameter or `x-engram-client-id` header is `403 CLIENT_SCOPE_FORBIDDEN`, never a fallback to `axon-web`. Signing paths re-assert that the record's `clientId` matches the stream's client, so a mis-scoped row can never be signed into the chain. A future second consumer gets its own credential and its own stream, not a parameter on this one.

### 3. Events and snapshots

Every mutation appends one immutable event to a single client-scoped, gap-free chain: `sequence` starts at 1 and increases by exactly one, `event_id` is globally unique, and `prev_event_hash` is the SHA-256 base64url hash of the prior signed JWS (null only at sequence 1). Events and snapshots are compact JWS with a protected header of `alg=RS256`, `typ=engram-enrollment+jws`, `kid`, and `contract_version=1`. Grant and revoke are idempotent — a repeat of the same decision appends no event — and both run in a serializable transaction with a bounded retry so a concurrent-write abort surfaces as a retry, never as a gap or a double append.

- **`GET /events?after_sequence=&limit=`** delivers ordered events under a repeatable-read snapshot bounded by the signed head, so a concurrent append cannot leak past it. Delivery is at-least-once and recorded per consumer.
- **`GET /snapshot`** returns the complete signed current state for bootstrap and reconciliation. Each response is generated and signed at request time, is `Cache-Control: no-store`, and is always a fresh statement. Recording its delivery receipt is a **single idempotent insert on a unique key, deliberately outside any transaction and at the default isolation level**. It guards no cross-row invariant, so serializable isolation would buy nothing — and, because concurrent polls are the expected shape, would cost availability: escalating it made concurrent readers abort one another and turned a read into a deny (see the amended note under Consequences). Serializability is reserved for the writes that genuinely need it: the gap-free chain append above, acknowledgement, and the retention advance in §6.

  Collecting expired receipts is maintenance, not part of any invariant. It runs **outside** the delivery transaction, bounded in rows per sweep so it cannot lengthen a response, and best-effort — failing to collect garbage must never deny a consumer. It prunes past the poll budget **plus a skew allowance**, not at the budget itself: the contract already tolerates 60 s of consumer clock skew, so pruning exactly at the boundary let a legitimate in-budget acknowledgement lose a race to the sweep and silently strand the §6 retention proof.
- **`POST /acknowledgements`** is the consumer's durable receipt. It never advances over an undelivered, mismatched, gapped, or regressing head, and a snapshot acknowledgement must match a recorded snapshot delivery by JWS hash. The acknowledgement keeps that last snapshot receipt independently of later event receipts, so normal event following never destroys the retention proof. Snapshot receipts remain acknowledgeable for their signed 90-second poll budget, then are pruned unless retained as that recovery receipt; a consumer can always fetch a fresh snapshot.

A stale snapshot must never overwrite newer consumer state, and a duplicate `sequence` with different bytes is a conflict that denies pending reconciliation.

### 4. A bounded, signed poll budget (`state_valid_until`)

Freshness is Engram's assertion, not the consumer's choice. Every enrollment assertion and every snapshot envelope carries **`state_valid_until`** _inside the signed payload_ — no proxy, cache, or consumer can extend it. It is `generated_at + 90s` (`ENROLLMENT_STATE_POLL_BUDGET_MS`), and it is a **required** field of contract v1.

The consumer may serve allow decisions from its durable acknowledged state only while its own trusted clock is before the newest `state_valid_until` it has verified. Past that instant it **denies every protected request** until it verifies fresh signed state. Clock rules are the contract's: RFC 3339 UTC, the consumer's own clock, at most 60 s of future-`issued_at` skew tolerance.

Only a **freshly signed snapshot** renews the budget. An empty event page and a successful acknowledgement are unsigned or historical and renew nothing. Events carry the `state_valid_until` in force when they were _appended_, so a replayed event tells the consumer what changed but does not make its state current. The operative consumer rule is therefore: take a signed snapshot at a cadence strictly under 90 s, or deny.

**Fail-closed behavior is uniform.** Deny on `503`, network failure, an elapsed `state_valid_until`, signature or `kid` verification failure, an unexpected `contract_version`, or an unknown signed enum value. Never allow from expired cached state, and never degrade to "last known good." Denial is scoped to Cite's protected surface: it is **not** an Engram session change and must not sign the user out of the IdP.

This bounds the worst-case visibility of a revocation to the budget plus the consumer's processing time, with no push channel and no reliance on the consumer's own timers being generous.

### 5. A dedicated signing key with an explicit overlap and retirement

Enrollment signs with its **own** RS256 keypair, never the JWT signing material of ADR-014/ADR-025 and never the ADR-031 derived encryption key. Compromise scope, rotation cadence, and audience all differ; sharing key material would make a JWT rotation retire enrollment history and an enrollment rotation a suite-wide session event. On aws-prod the key lives in its own Secrets Manager secret (`<secretPrefix>/enrollment-signing`), separate from `<secretPrefix>/jwt-rs256`, holding `kid`, both PEMs, and the validity window together so the key and its window rotate atomically.

**Amended 2026-08-04 — how prod reads that secret.** This section originally had the prod web stack inject all five fields as per-key `{{resolve:secretsmanager:…}}` references into the Lambda environment. **That is not deployable.** Lambda caps an `UpdateFunctionConfiguration` request at 5120 bytes; the five fields are ~3.3 KB against an environment already at ~3.6 KB, so the first production promotion failed with HTTP 413 and CloudFormation rolled the web stack back. The limit is not negotiable by tuning — even a 2048-bit key overruns it — so key material cannot travel in the prod environment at all.

Prod now receives only the secret **name**, in `ENGRAM_ENROLLMENT_SIGNING_SECRET_ID` (~40 bytes), and `src/lib/enrollment-crypto.ts` fetches and caches the material on the first enrollment request. This preserves the properties that matter: nothing runs on the startup path (§8.1), nothing runs on a session path (§8.4), and a fetch failure degrades to `503` — the same fail-closed deny the surface already promises (§8.5). It also removes private key material from a place readable via the function configuration.

aws-dev and on-prem are unaffected and still read the individual variables: they are containers with an env file and have no equivalent ceiling. The code chooses its source by whether `ENGRAM_ENROLLMENT_SIGNING_SECRET_ID` is set. The four optional overlap variables remain environment-injected — at ~850 B they fit, and they carry only public material.

Operational detail and the pre-add checklist live in [`docs/runbooks/aws-prod-lambda-env-budget.md`](../runbooks/aws-prod-lambda-env-budget.md).

`GET /keys` publishes the **active** key plus, during rotation only, one **overlap** key, each with `kid`, `alg=RS256`, `use=sig`, `contract_version`, `not_before`, `not_after`, and `status`. HMAC keys are never published or accepted. Retired keys are never published, so a consumer meeting an unknown `kid` denies rather than falling back.

`/keys` deliberately reads no private material and does **not** assert the active signing window: verification material must outlive the signing window so a consumer can still verify already-issued state and then deny it by the published interval. Signing does assert the window, so after `not_after` the authority stops minting and the surface degrades to `503` — an expiry becomes a deny, never an ambiguity.

Configuration is validated as a _set_, not as "PEM-looking strings": a sign-then-verify probe proves the active pair; the active window must be current; the four overlap variables must be present together; the overlap `kid` must differ from the active `kid`; the overlap interval must genuinely overlap the active one, must itself be current, and must end no later than the active `not_after`. That validation runs as a **pre-deploy gate** (§7), not on the request or boot path. Signing always uses the active key — overlap is a _verification_ affordance only.

Rotation is a fixed, ordered lifecycle:

1. Generate a new keypair with a new `kid`.
2. Deploy it as **active** and demote the prior key to **overlap** with a bounded window.
3. Let the consumer converge: it holds an acknowledged snapshot signed by the **new active** key.
4. **Retire** — remove all four overlap variables. The old key is now unpublished, and any message signed by it is undecidable to a consumer.
5. Only then advance retention (§6) past events signed solely by the retired key.

Steps 3–5 are the point of the ordering: retirement is what makes old events unverifiable, so acknowledgement must precede retirement and retirement must precede pruning.

### 6. Retention requires an acknowledged consumer snapshot before pruning

Pruning must not be able to strand a consumer. In the same serializable transaction as the delete, advancing the retained floor to `firstRetainedSequence` requires **all** of:

- the floor is within the stream and moves forward only (`retainedFrom ≤ floor ≤ headSequence`), so the current immutable head is always retained;
- the registered consumer's durable acknowledgement has reached `floor − 1`, so it needs nothing below the floor;
- that acknowledgement has a **prior snapshot** receipt whose hash matches a recorded snapshot delivery and whose head is at or above the floor. Later event acknowledgements may advance the cursor without discarding that proof.

Requiring an acknowledged _snapshot_ rather than a bare event cursor is deliberate: it proves the consumer can rebuild its entire state from signed material that remains verifiable after retirement, which a cursor over deleted events does not. A stream with no such acknowledgement never prunes.

A consumer whose cursor falls below the floor receives `409 CURSOR_EXPIRED`, fetches and verifies a current snapshot, and acknowledges its head. Historical events signed solely by a retired key are never replayed.

### 7. Administrative controls are superadmin-only and audited

Grant, revoke, and retention are platform-superadmin operations on `/api/admin/enrollments*`, gated identically:

- the role is re-read from the database (`isCurrentPlatformSuperadmin`), not taken from the 15-minute JWT claim;
- cookie-authenticated writes pass the ADR-013 CSRF check (`hasCrossOriginCookieWrite`);
- the internal-service principal is **explicitly refused**. Machine credentials read the stream; only a human superadmin changes admission.

Grant requires an existing `User.id` and an `expiresAt` that is in the future and **within 90 days**. There is no unbounded enrollment: expiry is a first-class deny path expressed in signed state rather than a background job, and the cap bounds the damage of a lost revocation to one enrollment term. Revoke accepts a bounded reason (≤ 256 chars) carried in the signed assertion. Both are idempotent, both bump `version`, both append exactly one event, and all three operations emit `cite.enrollment.grant` / `.revoke` / `.retention` audit events.

Once Engram durably records a revocation, any Cite session bound to that enrollment must be denied on its next protected request.

### 8. Environment behavior — Cite unavailable must not take the shared IdP down

The enrollment surface is its own failure domain, in both directions.

1. **Enrollment is not a liveness dependency of the IdP.** Nothing enrollment-related runs in `instrumentation.register()` or in `docker-entrypoint.sh`. An expired or missing Cite key must never stop Engram from issuing tokens for Tradepost, FieldOps, or the suite — and on Lambda a throw at startup would do exactly that, at every cold start, turning a scheduled `ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER` into a total identity outage.
2. **Strict validation is a deploy-time gate, not a runtime one.** `cortex-deploy.toml` runs `scripts/validate-enrollment-startup.mjs` as an aws-dev pre-deploy step: a misconfigured key set fails the _deploy_, before traffic, while the already-running IdP is untouched. On aws-prod the same property comes from the stack's secret references, which must resolve at deploy time.
3. **An environment may simply not run the authority.** The enrollment variables are optional and mapped in on-prem as well as aws-dev; left empty, the four `/api/internal/enrollment/v1/*` routes answer `503 ENROLLMENT_STATE_UNAVAILABLE` — the consumer's fail-closed path — while everything else serves normally. Cite absence is a configuration state, not an error.
4. **No enrollment code path runs on a session path** — not in login, refresh, continue, token, OAuth, magic-link, or authorize. Enrollment tables are never read while authenticating, so enrollment load or lock contention cannot slow the IdP.
5. **Degradation never silently allows.** Any enrollment read or write that cannot complete durably returns `503`, never a partial, cached, or optimistic answer.

### 9. Versioning

Consumers pin the `v1` path major and accept only `contract_version=1` in signed messages, ignoring unknown fields and denying unknown signed enum values. Optional additive fields and new error codes are minor releases; a changed meaning, removed field, newly required field, algorithm change, canonicalization change, or acknowledgement-rule change requires a new path major. A retired major returns `CONTRACT_VERSION_UNSUPPORTED` and is never silently downgraded. The v1 document is the complete contract — it is frozen at the first shipped consumer, and until then it is amended in place rather than forked.

## Consequences

- **Admission is provable and ordered.** Engram can show exactly what it asserted and when; Cite can show it received every mutation. Neither side can quietly diverge, because divergence surfaces as a conflict or an expired cursor instead of a wrong allow.
- **Two admission models now coexist.** Tenancy (`OrgAppEntitlement` / `UserAppEntitlement`) still governs the hosted suite; enrollment governs Cite. Operators must know which one they are editing — the org UI does not change Cite access, and enrollment does not grant a Nexus workspace. This is the cost of not overloading tenancy, and it is the intended cost.
- **Fail-closed is load-bearing, and the poll budget sets the floor.** A Cite outage longer than 90 s denies users rather than serving stale allows, and a compliant consumer must take a freshly signed snapshot at least that often. Enrollment availability becomes a real SLO for the Cite surface — explicitly not for the shared IdP. The endpoints are gated by a dedicated machine credential but are not rate-limited, so the budget describes the expected load rather than enforcing a ceiling.

  **Amended 2026-08-04.** This paragraph previously ended "a runaway consumer is a signing-cost problem, not a correctness one." That was false as first implemented, and the correction matters because it inverts the claim. Concurrent polling contended on the delivery write (§3 below), the bounded retry could not absorb it, and the surface answered `503` — which §4 makes a hard **deny**. Concurrency on a read endpoint therefore denied real users, with no external cause. Measured on real PostgreSQL, concurrent callers conflicted 66–87% of the time before retries. A consumer is not "runaway" to reach this: a compliant one must poll under 90 s, and more than one warm instance is ordinary. Load is a correctness concern here unless the write paths are non-contending by construction, which is now what §3 requires.
- **A second key to operate.** Enrollment has its own secret and its own five-step rotation with a consumer-convergence gate. Skipping step 3 strands the consumer; pruning before step 4 leaves history rooted in a key the consumer can still fetch. Generation and rotation of the secret itself are dry-run-by-default and human-approved (`docs/runbooks/enrollment-signing-secret-provisioning.md`). aws-prod deploys now also require `<secretPrefix>/enrollment-signing` to exist — a deploy-time precondition, consistent with §8.2.
- **Retention is a gated operation, not a cleanup job.** The stream grows until the consumer has acknowledged a currently-verifiable snapshot. A silently stalled consumer therefore shows up as unbounded growth in `EnrollmentEvent`, which is the right failure: visible, non-destructive, recoverable.
- **Contract safety coverage is concentrated.** The protected-header, freshness, and retention mutation checks run together in the real-PostgreSQL enrollment-contract integration suite. CI runs that suite, but it remains a deliberately visible single integration gate that must stay required.
- **The enrollment surface is separately revocable.** Rotating `ENGRAM_AXON_ENROLLMENT_API_KEY` cuts Cite off without touching any other internal consumer or any user session.
- **`axon` is overloaded in name only.** `axon-web` / `axon` remain the registry identifiers behind the Cite presentation, and enrollment binds to those identifiers rather than to the brand strings, so a future rebrand is presentation metadata again.

## Alternatives considered

- **A boolean on `UserAppEntitlement`.** Rejected: unsigned, historyless, and read through the tenancy model — a consumer could neither prove the decision nor prove it had seen every change, and any future change to entitlement semantics would move a paid boundary as a side effect.
- **An `enrolled` claim in the access JWT.** Rejected: revocation would take up to a token lifetime to bite, there is no consumer-side durable record, and shrinking the token lifetime to compensate would tax every client of the shared IdP for one client's requirement.
- **Poll-only, with no acknowledgement.** Rejected: without a durable receipt, Engram cannot know what the consumer holds, which makes safe retention and safe key retirement undecidable. Acknowledgement is what turns both into checkable preconditions.
- **Push webhooks to Axon instead of a pull stream.** Rejected: it inverts the failure mode — a missed or replayed delivery is invisible to Engram and, without an acknowledged cursor, indistinguishable from a consumer that is merely behind. Pull with an explicit cursor makes "how far behind is the consumer" a queryable fact. Push can be added later as a latency hint over the same acknowledged stream.
- **Conditional snapshot caching.** Rejected: a representation that is cacheable across requests cannot safely carry a moving freshness bound, and it weakens `no-store` for the complete enrollment roster while providing no valid freshness extension.
- **Reuse `ENGRAM_INTERNAL_API_KEY` (ADR-022) and the JWT signing key (ADR-014/025).** Rejected: one shared credential means one shared revocation, and one shared signing key means a JWT rotation would retire enrollment history. Two dedicated secrets are cheaper than that coupling.
- **Fail the process at startup when enrollment keys are invalid.** Rejected — this is the shared-IdP hazard in §8.1. Fail-fast buys nothing at runtime: the safety property Cite needs is a deny, which `503` already provides, while a boot failure converts a Cite-scoped defect into a suite-wide identity outage. The same strictness is retained where it is safe, as a pre-deploy gate.
- **Unbounded enrollment with revoke-only withdrawal.** Rejected: a required, capped `expiresAt` makes lapse the default and continuation the deliberate act.
