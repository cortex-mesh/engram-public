# ADR-021 — Per-Org Provider Credentials Store (BYO AI Keys)

**Status:** Accepted
**Date:** 2026-06-14
**Last Updated:** 2026-06-14
**Deciders:** Roland Parnaso
**Repos:** engram (this ADR — storage + lifecycle + admin API), nexus (entry UI, ADR-007/ADR-003 proxy consumer), cortex (runtime consumer — [cortex ADR-126](https://github.com/cortex-mesh/cortex/blob/main/docs/adr/ADR-126-per-tenant-provider-credentials.md))
**Related:** ADR-005 (org roles), ADR-007 (Nexus tenant-shell boundary), ADR-009 (per-user entitlements authz pattern), ADR-011 (per-app DB credentials — the suite Secrets-Manager pattern), ADR-020 (tenant-admin API — the OWNER/ADMIN auth pattern reused here), ADR-004 (CDK/AWS infra); cortex ADR-126 (per-tenant provider credentials — the design this ADR implements the storage half of), cortex ADR-112/124 (`credential_kind`/`credential_ref` per-org credential resolution)

## Context

The companion **cortex ADR-126 (Proposed)** — *Per-Tenant Provider Credentials*
([PR cortex#1301](https://github.com/cortex-mesh/cortex/pull/1301); merges to
`docs/adr/ADR-126-per-tenant-provider-credentials.md`) — proposes that the
multi-tenant hosted product needs **per-org bring-your-own provider keys (BYO
keys)**: an org admin supplies their own OpenAI / Anthropic (later Gemini, etc.)
credential, and that org's CORTEX tasks authenticate with it — for billing
isolation, data governance, and blast-radius containment.

ADR-126 splits the work across four repos and names **Engram as the storage
authority** because Engram already owns the org directory, identity, and the
hosted control plane:

| Concern | Repo |
| --- | --- |
| Entry (org admin types the key) | Nexus |
| **Storage (encrypted; served to runtime)** | **Engram — this ADR** |
| Consumption (resolve per `org_id` at task time) | cortex (ADR-126) |
| Fleet/platform default | Plexus |

ADR-126 also defines the runtime contract: cortex resolves a credential through the
existing per-org resolver (`hosted/app_credentials.py`), which turns a non-secret
**`credential_ref`** (named by `credential_kind`) into a secret at task time, and
**fail-soft**s to a fleet default on any miss. The control-plane snapshot carries
only *refs*, never plaintext. `CredentialRefKind` already defines
`aws_secrets_manager` (currently unwired).

This ADR decides **how Engram stores BYO provider keys and exposes them** to
Nexus (entry/management) and cortex (runtime), without Engram ever placing a
plaintext secret in its database, its API responses (beyond a masked hint), the
control-plane snapshot, or its logs.

### What already exists in Engram

- **Org authority:** the `Organization` model (cuid id, unique `slug`, entitlements).
- **Secrets pattern:** Engram already keeps its own runtime secrets in **AWS
  Secrets Manager** (`engram-dev-runtime`, `cortex-dev-data-master`) — per
  ADR-011. There is **no app-level field encryption** in the Engram DB today.
- **Admin auth pattern (ADR-020):** `authorizeOrgAdminRequest(request, { orgId, mutation })`
  admits an org **OWNER/ADMIN** to manage their own org via Bearer JWT (no cookie,
  CSRF-safe), re-reading role + membership from the DB, with `orgId` from the path.
  Nexus proxies these endpoints. This is exactly the surface BYO-key management needs.
- **Audit:** the `AuditLog` model (`action`, `outcome`, `actorUserId`, `orgId`,
  `targetType`/`targetId`, `metadata`) already records org state-change events.
- **Infra:** CDK in `infra/cdk`; the hosted execution lives on the cortex side
  (EC2 hosted worker), which today reads `credential_ref`s of kind
  `environment_variable` from its env.

## Decision

### D1 — AWS Secrets Manager is the secret store; the Engram DB holds only non-secret metadata

Store each BYO provider key as an **AWS Secrets Manager** secret, reusing the
suite pattern Engram already follows (ADR-011). The Engram Postgres DB stores a
new **`OrgProviderCredential`** row that holds only *non-secret* facts — never the
key:

```prisma
enum AiProviderKey {
  anthropic_api   // ANTHROPIC_API_KEY-family (also serves claude_code routes)
  codex           // OpenAI (OPENAI_API_KEY)
  kimi            // Moonshot (KIMI_API_KEY)
  openclaw        // OPENCLAW_AUTH_TOKEN
  hermes          // HERMES_AUTH_TOKEN
}

enum ProviderCredentialStatus {
  active
  disabled
}

model OrgProviderCredential {
  id             String                   @id @default(cuid())
  org            Organization             @relation(fields: [orgId], references: [id], onDelete: Cascade)
  orgId          String
  provider       AiProviderKey
  credentialKind String                   // "aws_secrets_manager" (target) | "environment_variable" (bridge)
  credentialRef  String                   // ASM secret name/ARN, or env var name in the bridge phase
  last4          String?                  // display hint only; never the full key
  status         ProviderCredentialStatus @default(active)
  createdAt      DateTime                 @default(now())
  updatedAt      DateTime                 @updatedAt
  rotatedAt      DateTime?
  createdByUserId String?

  @@unique([orgId, provider])
  @@index([orgId])
}
```

Rationale for ASM over DB field-encryption:

- **Reuses proven infra** (ADR-011) — no new encryption envelope, key rotation, or
  cipher code to design and audit in Engram.
- **Plaintext never enters the Engram DB** — the row is metadata + a ref, exactly
  like cortex's `service_principal_bindings` (ADR-124).
- **No synchronous Engram dependency on the task hot path** — the cortex worker
  reads ASM **directly** via IAM (see D4), rather than calling Engram per task.
- **Encryption-at-rest + KMS** are handled by ASM.

The DB-envelope-encryption alternative is recorded as a Considered Option (rejected).

### D2 — Secret naming convention + KMS

Per-org provider secrets follow a deterministic, org-partitioned name so IAM can
be scoped by path:

```
cortex/<env>/org/<orgId>/provider/<provider>      # e.g. cortex/dev/org/5407ec4e.../provider/anthropic_api
```

`<env>` ∈ `{dev, prod}` (ADR-075 profiles). The secret value is the raw provider
key string. A single KMS key (suite-owned, e.g. `cortex-<env>-provider-creds`)
encrypts all per-org provider secrets; Engram's role gets `kms:Encrypt` + ASM
write, the cortex hosted-worker role gets `kms:Decrypt` + ASM read on the
`cortex/<env>/org/*/provider/*` path only (D4).

### D3 — Tenant-admin API (Nexus-facing), reusing the ADR-020 pattern

All endpoints use `authorizeOrgAdminRequest` (OWNER/ADMIN of the path `orgId`,
Bearer, no cookie). Nexus proxies them from the per-org settings page.

| Method + Path | Purpose | Body / Response |
| --- | --- | --- |
| `GET /api/orgs/:orgId/provider-credentials` | List BYO status per provider | Response: `[{ provider, status, last4, rotatedAt, configured }]` — **never** the key |
| `PUT /api/orgs/:orgId/provider-credentials/:provider` | Set or rotate a key | Body: `{ apiKey }` → Engram writes ASM, upserts the row (`last4`, `rotatedAt`), audits. The key is **never** persisted to the DB or logged. |
| `DELETE /api/orgs/:orgId/provider-credentials/:provider` | Remove a key | Disables the row and deletes the ASM secret; org reverts to fleet default |
| `POST /api/orgs/:orgId/provider-credentials/:provider/test` | Validity check | Engram makes a cheap provider ping with the supplied/stored key → `{ ok, detail }`; no persistence on a bare test |

- **ADMIN vs OWNER:** managing BYO keys is allowed to OWNER and ADMIN (a financial/
  governance control, same tier as member management in ADR-020). No OWNER-only
  escalation guard is needed (there is no privilege-escalation vector here).
- **Validation:** `provider` must be a valid `AiProviderKey`; `apiKey` must be
  non-empty and pass a cheap shape check (prefix/length) before an ASM write.
- **Idempotent rotation:** `PUT` over an existing provider rotates in place
  (overwrites the ASM secret value, bumps `rotatedAt`).

### D4 — Runtime exposure to cortex: refs in the control plane, secret read directly from ASM

cortex must learn the **binding** (the non-secret ref) and then read the secret.
Two delivery phases mirror cortex's own control-plane maturation
(`hosted/config.py` is explicitly "a bridge… while Plexus-backed APIs are still
being built"):

- **Bridge phase (small, static tenant set):** the per-org provider binding is
  expressed as a `credential_kind = "environment_variable"` ref in cortex's
  `config/hosted-agents/<env>.toml` seed, exactly like `service_principal_bindings`
  today. Engram's role is the **record of truth + admin UX**; the secret is an env
  var on the worker. This unblocks end-to-end testing without new IAM.
- **Target phase:** Engram exposes the **non-secret** bindings to cortex's
  control-plane snapshot loader via an internal, internal-key-authenticated read:

  ```
  GET /api/internal/hosted/provider-credential-bindings?env=<env>
    → [{ orgId, provider, credentialKind: "aws_secrets_manager", credentialRef: "cortex/dev/org/.../provider/anthropic_api", status }]
  ```

  cortex projects these into `HostedControlPlaneSnapshot`, and its
  `ProviderCredentialResolver` (ADR-126) resolves the `aws_secrets_manager` kind by
  reading ASM **directly** with the worker's IAM role (D2) — **wiring the
  `CredentialRefKind.AWS_SECRETS_MANAGER` branch that is defined but unimplemented
  today** (`app_credentials.py:_resolve_credential_ref`). Engram is never on the
  per-task path; the binding ref carries no secret.

This keeps the ADR-126 invariant intact: the snapshot carries only refs; the
worker resolves the secret; Engram owns lifecycle and the encrypted material.

### D5 — Audit

Reuse `AuditLog`. Add audit actions:

- `org.provider_credential.set`
- `org.provider_credential.rotate`
- `org.provider_credential.delete`
- `org.provider_credential.test` (record outcome, not the key)

Each records `actorUserId`, `orgId`, `targetType="provider_credential"`,
`targetId=<provider>`, `outcome`, and `metadata` (e.g. `{ last4 }`) — **never** the
secret. Per ADR-020 D4, the `GET` list endpoint (a read) is not audited.

### D6 — Secret value never crosses a view layer, a snapshot, or a log in plaintext

- Nexus transmits the key only in the `PUT`/`test` request body over TLS; it does
  not persist or log it (ADR-007 boundary: Nexus proxies, never stores secrets).
- Engram writes the key straight to ASM and stores only `last4` + the ref; it never
  logs the key and never returns it on any read.
- The control-plane snapshot and the cortex resolver log `set | none`, never the
  secret (matching `app_credentials.py` today).

## Considered Options

### A. AWS Secrets Manager store + DB metadata/ref (CHOSEN)

Per D1–D4. **Pros:** reuses ADR-011 infra, no new crypto, plaintext never in the
Engram DB, no per-task Engram dependency, wires the already-defined ASM
`CredentialRefKind`. **Cons:** requires IAM/KMS scoping (D2) and finally
implementing the ASM resolver branch on the cortex side.

### B. App-level envelope encryption in the Engram Postgres DB

Store ciphertext in `OrgProviderCredential.ciphertext`, encrypted with a
KMS-derived data key; expose a runtime-scoped decrypt API cortex calls per task.
**Rejected:** introduces net-new encryption code + key management in Engram, puts
Engram on the per-task hot path (or forces a worker-side decrypt-and-cache anyway),
and means Engram hands plaintext back over an API — more secret-handling surface
than ASM, for no benefit when ASM already exists in the suite.

### C. Store BYO keys only in cortex (TOML/Plexus), not Engram

**Rejected:** Engram is the org authority; org-scoped secrets and their admin UX
belong with the org directory (ADR-005/007). Cortex remains the *consumer*; Plexus
remains the *fleet default*, not the per-tenant store.

### D. Per-user provider keys

**Deferred** (matches ADR-126 option E): billing/governance is org-level in this
product. The `@@unique([orgId, provider])` shape can later widen to include a user
dimension without changing the storage model.

## Consequences

**Positive**

- One suite-consistent secret pattern (ASM, ADR-011) now covers provider BYO keys.
- Engram owns lifecycle + admin UX + audit; plaintext never touches its DB, its
  reads, the snapshot, or logs.
- No per-task Engram dependency; the worker reads ASM directly (cacheable).
- Strictly additive: orgs without a BYO key fall through to the fleet default
  (cortex ADR-126), so existing behavior is unchanged.

**Negative / costs**

- New Prisma model + migration (`OrgProviderCredential`, `AiProviderKey`,
  `ProviderCredentialStatus`) and four admin endpoints.
- IAM/KMS work (D2): scoped write for Engram's role, scoped read for the cortex
  worker role, on `cortex/<env>/org/*/provider/*`.
- Requires cortex to implement the `aws_secrets_manager` resolver branch (ADR-126
  consumption work) for the target phase; the bridge phase needs only TOML +
  env-var, no new IAM.
- A test-key action calls out to third-party provider APIs (rate/latency
  considerations; keep it cheap and OWNER/ADMIN-gated).

**Neutral**

- No change to Engram's identity/auth core; this is a new org-scoped resource
  reusing the ADR-020 authz helper and the ADR-011 secrets pattern.

## Rollout (suggested phasing, aligned with cortex ADR-126)

1. **Engram (bridge):** add the Prisma model + migration, the four admin endpoints
   (`authorizeOrgAdminRequest`), and audit actions. Write secrets to ASM; emit the
   binding as an `environment_variable` ref into the cortex seed for the initial
   static tenant set.
2. **Nexus:** per-org "AI Providers" settings page → Engram admin API; masked
   status + test-key action (ADR-007 proxy, Bearer, no cookie).
3. **Engram (target):** add the internal `provider-credential-bindings` read; switch
   refs to `aws_secrets_manager`; provision KMS + scoped IAM (D2).
4. **cortex:** project bindings into the snapshot; implement the
   `CredentialRefKind.AWS_SECRETS_MANAGER` resolver branch with per-`(orgId, provider)`
   caching (ADR-126).
5. **Enablement:** per-org opt-in; provisioning a real key remains an org-admin
   action. No production cutover beyond per-org adoption.

**Out of scope:** per-user keys (option D); auto-provisioning BYO on org create;
non-AI provider secrets; the cortex-side resolver implementation details (owned by
cortex ADR-126).

---

## Amendment Notes

- **2026-06-14 — Accepted.** Status moved Proposed → Accepted alongside the cortex
  companion (cortex ADR-126, merged). Implementation is tracked by the meta-repo goal
  prompt *Per-Tenant Provider Credentials (BYO AI Keys)*
  (`docs/plans/2026-06-14-per-tenant-provider-credentials-goal-prompt.md`, worker-c).
- **2026-06-14 — Live secret/infra provisioning explicitly descoped from the autonomous
  build (goal D2/D3).** The build adds the `OrgProviderCredential` model, the OWNER/ADMIN
  admin API, and audit, and writes secrets through the ASM client **abstraction exercised
  only with a mock in tests**. Creating KMS keys, granting/modifying IAM, provisioning
  live AWS Secrets Manager entries, entering any real provider key, enabling a live BYO
  key for an org, and aws-prod cutover are **human gates (Roland)** — never performed
  autonomously. The bridge phase (env-var refs in the cortex seed) is the autonomous
  target; the `aws_secrets_manager` target phase is built but not provisioned.
- **2026-06-14 — Gate 1 (live aws-dev infra) provisioned (Roland), with a deviation from
  D2's CMK.** The `aws_secrets_manager` target path is now provisioned on **aws-dev**:
  - **No dedicated CMK.** `src/lib/asm-client.ts` pins no `KmsKeyId`, so secrets land on
    the **default `aws/secretsmanager` key** — matching the existing per-org
    `cortex/dev/SYNAPSE_AGENT_KEY_DEMO` precedent (its IAM is pure `GetSecretValue`, no
    `kms:*`). D2's dedicated CMK (`cortex-<env>-provider-creds`) is **deferred to a
    pre-aws-prod hardening item**: it would add defense-in-depth + an independent kill
    switch but requires pinning `KmsKeyId` in `asm-client.ts` + KMS-scoped IAM. Chose the
    default key now to match the as-built code and unblock the path; revisit before
    aws-prod, where real customer BYO keys land.
  - **One role, not two.** D2 names "Engram's role" (write) and "the cortex hosted-worker
    role" (read) separately. On aws-dev the **`engram` container (writer) and the
    `cortex-hosted-agent-worker` container (reader) both run on the `cortex-dev-app-host`
    instance**, so the single instance role
    (`cortex-dev-app-host-AppHostRole65D18652-…`) carries both. Live grant: inline policy
    `ProviderCredentialStore` — write (`CreateSecret`/`PutSecretValue`/`DeleteSecret`/
    `DescribeSecret`) + read (`GetSecretValue`) on
    `arn:aws:secretsmanager:us-west-2:782369544445:secret:cortex/dev/org/*/provider/*`.
    Codified in CDK at cortex `infra/cdk/lib/app-stack.ts` (cortex PR #1309); the inline
    policy is redundant once that ships via `cdk deploy`.
  - **`AWS_REGION` is required.** `asm-client.ts` no-ops writes / throws reads when
    `AWS_REGION` is unset. The aws-dev `engram` container had it unset, so the write path
    silently no-op'd. Added `AWS_REGION=us-west-2` to the `engram-dev-runtime` bundle +
    an aws-dev-scoped `env_var` in engram's `cortex-deploy.toml` (engram PR #117).
    **`ENGRAM_DEPLOY_ENV`** is unset and defaults to `"dev"` in `providerSecretId()`, so
    the secret path matches the IAM scope on aws-dev; it **must be set to `"prod"` for
    aws-prod** so the path and IAM line up.
