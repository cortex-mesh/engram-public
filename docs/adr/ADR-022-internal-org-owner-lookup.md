# ADR-022 — Internal Org-Owner Lookup: `GET /api/internal/orgs/{orgId}/owner`

**Status:** Accepted
**Date:** 2026-06-15
**Last Updated:** 2026-06-16
**Deciders:** Roland Parnaso (async, per the Ticket-to-Fix goal prompt's Phase-0 gate, 2026-06-15)
**Repos:** engram (this ADR — the lookup endpoint + an internal-only service guard), cortex (the sole runtime consumer — [cortex ADR-132](https://github.com/cortex-mesh/cortex/blob/main/docs/adr/ADR-132-ticket-to-fix-orchestration.md) §D4 froze this contract)
**Related:** ADR-005 (org roles), ADR-013 (browser SSO cookie & CSRF contract — internal/Bearer callers carry no cookie and pass CSRF), ADR-020 (tenant-admin OWNER/ADMIN endpoints — JWT-gated to the org's *own* owner/admin; cannot be called server-to-server, which is why this internal read is needed); cortex ADR-132 (the Ticket-to-Fix orchestration that calls this to OWNER-gate **Fix now** and to target the owner-ask), Pulse ADR-022 (the `requireInternalService` shape this mirrors). Part of the **Ticket-to-Fix** goal (`docs/plans/2026-06-15-ticket-to-fix-workflow-goal-prompt.md` in the cortex-mesh meta-repo).

---

## Context

Ticket-to-Fix (cortex ADR-132) gates the privileged **Fix now** dispatch — and targets the durable owner-ask (`FeedbackManager`) — on "who is this org's **owner**." cortex is the single authoritative gate (Synapse delegates to it; Synapse ADR-052 §D4), so cortex needs a server-to-server way to ask Engram "who owns org X."

Engram owns org membership and roles: `OrgMember.role` is an `OrgRole` (`OWNER | ADMIN | MEMBER`), and the `@@unique([userId, orgId])` constraint means a user appears at most once per org. But:

- **The existing owner/admin endpoints (ADR-020) are JWT-gated to the org's own OWNER/ADMIN** (admitted via Bearer through the Nexus proxy, reusing the ADR-009 authz pattern). They are designed for a logged-in org admin managing their own org — **not** for a trusted backend service resolving an owner on behalf of the system. cortex has no org-user JWT to present.
- **An internal-service auth mechanism already exists** but is not exposed as an internal-only *owner read*. `authenticateRequest` (`src/lib/auth.ts`) already accepts an `x-internal-api-key` header validated (timing-safe) against `process.env.ENGRAM_INTERNAL_API_KEY`, returning `{ userId: "internal", role: "ADMIN" }`; and an `/api/internal/*` namespace already exists (`/api/internal/tls/allow`). What is missing is (a) an **internal-only** guard that admits *only* the internal key (not a user cookie/JWT — an end user must never be able to enumerate owners), and (b) the owner-read route itself.

This ADR (pulled into Phase 0 at Roland's election, replacing cortex ADR-132's Phase-3 deferral) freezes both, matching the contract cortex ADR-132 §D4 already specifies.

## Decision

### 1. A dedicated internal-only service guard — `requireInternalService`

Add a small `requireInternalService(request)` helper (in `src/lib/auth.ts` alongside `authenticateRequest`, or a sibling `src/lib/internal-auth.ts`), mirroring Pulse's `requireInternalService` (Pulse ADR-022): it validates **only** the `x-internal-api-key` header (timing-safe) against the **existing** `ENGRAM_INTERNAL_API_KEY` and returns `{ ok: true }` or a `404` denial.

- **Internal-only** is the point: unlike `authenticateRequest` (which *also* admits a user cookie/JWT), this guard rejects everything except the internal key, so no authenticated end user can reach the route. It is the same secret and the same timing-safe comparison the internal branch of `authenticateRequest` already uses — **no new secret** (`ENGRAM_INTERNAL_API_KEY` is already provisioned and referenced).
- Denials return `404` (not `401`/`403`) with `Cache-Control: no-store`, matching the existing `/api/internal/tls` route's `deny()` posture, so the route's existence isn't probeable by an unkeyed caller.
- CSRF: internal callers send no cookie and pass the ADR-013 cross-origin-cookie-write check by construction (Bearer/internal callers pass). The route is a read-only `GET`, so no CSRF surface regardless.

### 2. `GET /api/internal/orgs/{orgId}/owner`

A new route under the existing internal namespace, guarded by §1.

```
GET /api/internal/orgs/{orgId}/owner
  Headers: X-Internal-API-Key: <ENGRAM_INTERNAL_API_KEY>
  200 -> { "orgId": "<id>",
           "owner": { "engramUserId": "<User.id>", "email": "<User.email>",
                      "displayName": "<User.displayName | null>" },
           "owners": [ { "engramUserId": "<User.id>", "email": "<User.email>",
                         "displayName": "<User.displayName | null>" }, ... ] }
  404 -> unknown/invalid key (guard denial) OR org has no OWNER
```

> **Amended 2026-06-16:** the endpoint now also returns an `owners` array containing **all** org OWNER members (same deterministic ordering as `owner`). The `owner` field is preserved for backward compatibility and equals `owners[0]`. See **Amendment Notes** below.

**Resolution semantics (deterministic; resolves cortex ADR-132 §D4's reliability concern):**
- Query `OrgMember` where `orgId == {orgId}` and `role == OWNER`, joined to `User`.
- **Exactly one OWNER** (the provisioning invariant): return it.
- **Multiple OWNERs** (not prevented by the schema): return the **deterministic primary** — the lowest-`createdAt` OWNER, tie-broken by `OrgMember.id` — so repeated calls are stable. (Matches cortex ADR-132 §D4's "lowest-`createdAt` OWNER" rule.)
- **Zero OWNERs** (mis-provisioned org): `404`, so the caller **fails closed** (cortex aborts the dispatch / owner-ask rather than dispatching ungated).

The response carries only the owner's `engramUserId` (the `User.id` cortex compares the clicker against), plus `email`/`displayName` for the `@owner` mention/labeling. No tokens, no other members, no roles beyond the resolved owner. The field names match cortex ADR-132 §D4 verbatim so the consumer needs no adaptation.

### 3. Read-only, non-admin, side-effect-free

The endpoint is a read. It does not mutate, does not issue tokens, and is **not** the ADR-020 admin path (no org-JWT, no SUPERADMIN). It returns the same trust level as the existing internal branch of `authenticateRequest` — a fully-trusted internal caller (the key holder) reading directory data. The `orgId` is supplied by that trusted caller; the key is the trust boundary (identical posture to the `/api/internal/tls` lookup). No rate-limiting is required for an internal-key-gated read; audit logging is optional (a read, not a security event) and may be added if desired.

## Consequences

**Positive**
- Reuses the existing `ENGRAM_INTERNAL_API_KEY` + timing-safe pattern and the existing `/api/internal/*` namespace — minimal new surface, **no new secret**, no schema change.
- An explicit internal-**only** guard closes the gap that `authenticateRequest` would otherwise leave (it also admits user JWTs) — an end user can never enumerate owners.
- Deterministic resolution + fail-closed `404` give cortex a reliable, single-valued owner for the authoritative Fix-now gate and the owner-ask.
- Field names match the already-frozen cortex ADR-132 §D4 contract, so the two ADRs interlock with zero drift.

**Negative / trade-offs**
- The endpoint returns owner PII (email/displayName) to the key holder. Acceptable: the internal key is the trust boundary and already grants `role: "ADMIN"` via `authenticateRequest`; this exposes strictly less.
- A second internal consumer of `ENGRAM_INTERNAL_API_KEY` (cortex) means the value must be **materialized in cortex's runtime env** before the lookup works — a human-gated ops step (same posture as the Pulse internal key; **no new secret**, only placement). Flagged in cortex ADR-132 Follow-ups.
- The schema permits multiple OWNERs; this ADR resolves that at read time (deterministic primary) rather than adding a single-OWNER DB constraint — deferred as a possible future hardening, out of scope here.

**Follow-ups**
- Phase 3 (engram): implement `requireInternalService` + `GET /api/internal/orgs/{orgId}/owner` with tests (internal-key-required → `404` without the key; deterministic multi-OWNER resolution; `404` on zero-OWNER); `npm run typecheck && npm run lint`.
- Phase 3 (ops, human-gated): materialize `ENGRAM_INTERNAL_API_KEY` in cortex's runtime env (value already exists).
- Possible future: a single-OWNER DB invariant to make the read trivially single-valued.

## Amendment Notes

**2026-06-16**

1. The endpoint now returns an `owners: [{ engramUserId, email, displayName }]` array — **all** of the org's OWNER members — alongside the existing backward-compat `owner` field. The `owners` entries use the same deterministic ordering as `owner` (lowest-`createdAt`, tie-broken by `OrgMember.id`).
2. The implementation changes from `findFirst` to `findMany` (returning every OWNER, not just the primary). Backward compatibility is preserved: the `owner` field stays and is exactly `owners[0]` (the deterministic primary).
3. **Rationale:** cortex ADR-132 §D4 was amended (2026-06-16) so the **Fix now** gate accepts **any** org OWNER rather than only the single deterministic primary. Returning the full `owners` array gives the cortex gate the data it needs to authorize any OWNER click.
4. Roland approved this amendment (2026-06-16).
