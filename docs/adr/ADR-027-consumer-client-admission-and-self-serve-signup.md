# ADR-027: Consumer-Client Admission and Self-Serve Signup via Designated-Org Auto-Join

**Status:** Accepted
**Date:** 2026-07-16
**Deciders:** Roland
**Related:** ADR-002 (native client authentication), ADR-005 (org roles & app entitlements), ADR-010 (consumer app admission pattern), ADR-015 (invitation-only admission and waitlist), ADR-016 (native PKCE auth-code issuance), ADR-017 (OAuth-only set-password flow), ADR-018 (Tradepost native client), Tradepost ADR-003 (tenancy model)

## Context

The suite now has two distinct client shapes authenticating against Engram:

1. **Org-tenant apps** (Synapse, Thoughts, Pulse, Gyrus) — served under the Nexus tenant shell at `<org>.ctxhost.com/<app>`, admitted via org membership + `OrgAppEntitlement` (ADR-010, ADR-016).
2. **Consumer apps** — dedicated-product-host apps where Engram supplies *identity only* and all authorization is per-user resource ownership inside the app. Tradepost (`tradepost-web`, ADR-018) is the first: `ccgtradepost.com`, anonymous-first, no org concept in the product.

ADR-018 deliberately deferred the consumer admission model: "for now Tradepost sign-in rides org app entitlements like every other app… The ADR-003 self-serve-signup-auto-joining-a-tradepost-org model is a future, separate ADR." This is that ADR.

The stopgap has three costs today:

- **Manual admission.** Waitlist approval (`POST /api/admin/waitlist/approve`) creates a bare platform `User` and emails a set-password link — but grants no org membership. Because `validateNativeAuthorizationAdmission` requires membership in an org with the bound app entitled, an approved Tradepost user **still cannot sign in** until an operator separately adds them to the reserved `tradepost` org. Nothing automates that step; on aws-dev it was papered over by seeding the demo tenant with the `tradepost` entitlement.
- **Launch gate.** Tradepost ADR-003 records "Engram needs public self-serve signup that auto-joins a designated org" as the blocker on Tradepost's public launch.
- **No recipe.** The next consumer app would rediscover all of this; the new-app playbook only documents the org-tenant path (amended alongside this ADR in the meta repo).

What already exists and is NOT changing: the `NativeAuthClient` registry with per-client branding and `signupMode` (`waitlist | open`, default `waitlist`, fail-closed); the shared `WaitlistRequest` table soft-scoped by `clientId` with Tradepost enrichment fields and the client-filtered superadmin queue; the ADR-016 admission check; ADR-015's non-admitting waitlist and anti-enumeration posture.

## Decisions

### D1. A "consumer client" is a `NativeAuthClient` with a designated auto-join org

**Decision:** Add one nullable column to the client registry:

```prisma
model NativeAuthClient {
  // ... existing fields ...
  autoJoinOrgSlug String?   // designated registry org for consumer clients; null for suite clients
}
```

A client with `autoJoinOrgSlug` set is a **consumer client**. Admission events for that client (D3, D4) auto-join the user into the designated org as `MEMBER`. Suite clients (`synapse-native`) and the null/suite waitlist lane leave it null and keep today's behavior exactly.

Seed: `tradepost-web → autoJoinOrgSlug = "tradepost"`.

**Rationale:** Slug (not org id) keys the mapping for the same reason as ADR-010 D5 — each environment issues its own org ids, and slug-keyed config is portable across aws-dev / on-prem / aws-prod and survives reseed. The designated org must exist with the bound app entitled (`OrgAppEntitlement`, per the client's `NATIVE_CLIENT_APP_BINDINGS` entry); startup/admin validation should surface a consumer client whose designated org is missing or unentitled, and admission-time failures fall through to today's fail-closed reasons.

### D2. The designated org is a registry org, not a collaboration org

**Decision:** The designated org (e.g. `tradepost`) exists purely as the user registry satisfying the ADR-016 admission check. It is not a workspace: it never gets a Nexus tenant host surface, suite apps other than the bound one are never entitled on it, and members never see each other through it. Auto-joined users get `OrgRole.MEMBER`, never `OWNER`/`ADMIN`.

**Rationale:** This is what makes "auto-join designated org" safe. The org-membership primitive is being reused as a per-user app grant; the org's only consumers are the admission check and operator tooling. Consumer apps do their own per-user authorization (Tradepost ADR-003) and ignore org context entirely. Engram surfaces that enumerate members (org pages, invite/mention pickers) must expect registry orgs to have unbounded member counts — operator UI should paginate and may badge registry orgs (any org referenced by some client's `autoJoinOrgSlug`) to discourage treating them as tenants.

### D3. Waitlist approval becomes clientId-aware and completes admission

**Decision:** `POST /api/admin/waitlist/approve` gains one step. After resolving/creating the `User` (existing behavior), if the request's `clientId` resolves to a consumer client (D1): upsert `OrgMember { userId, orgId(designated), role: MEMBER }` in the same transaction as the user creation. Then send the (already per-client-branded) set-password email as today. The audit event metadata gains the auto-joined org id.

Approval of suite-lane requests (`clientId` null or a client without `autoJoinOrgSlug`) is unchanged: bare user + set-password email, org membership stays a separate operator action.

**Rationale:** Removes the manual step that currently leaves approved Tradepost users unable to sign in. Membership upsert (not create) keeps re-approval and already-member cases idempotent. Entitlement is org-level and pre-exists on the designated org, so approval only ever touches membership.

### D4. Self-serve signup: `signupMode=open` on a consumer client admits end-to-end

**Decision:** When a consumer client's `signupMode` is flipped to `open`:

- **Password registration** — `POST /api/auth/register` (today hard-403 unless `signupMode === "open"`) creates the `User` **and** auto-joins the designated org in one transaction, then proceeds to the existing verified-email flow.
- **OAuth signup** — for an authorize flow carrying a consumer client's context with `signupMode=open`, an unknown provider-**verified** email may create a `User` and auto-join the designated org, instead of the ADR-015 redirect-to-waitlist. The clientId context must come from the server-side OAuth `state`, never from a client-supplied parameter on the callback. Outside a consumer-client `open` context, ADR-015 §3 stands: unknown OAuth users are never auto-provisioned.
- The `/register` page already branches on `signupMode` from `/api/auth/client-config`; no new UI surface is needed beyond the client's existing branded registration form.

`signupMode` stays a per-client DB value: flipping `tradepost-web` to `open` is the Tradepost launch switch; every suite client stays `waitlist`. Rate limiting and email hygiene on these paths follow the existing register/waitlist limiter posture.

**Rationale:** This scopes ADR-015's "no public self-service" rule instead of repealing it. The rule's purpose was to keep unknown users out of the *suite* control plane; a consumer client admits users only into its own registry org, which grants exactly one app and no tenant surface. ADR-015's Considered Option B (public accounts, gate app access later) was rejected partly because it created "authenticated-but-unadmitted accounts" — D4 avoids that class by making signup and admission atomic.

### D5. The waitlist stays one shared table, scoped by `clientId`

**Decision:** Keep the single `WaitlistRequest` table with unique-email keying and the `clientId` tag; do not split per-product tables or per-(email, clientId) rows. The known tradeoff — one email cannot sit in the Tradepost queue and the suite queue as two distinct requests — is accepted: the identity pool is shared (one email = one `User`), and approval admits the person under whichever lane their single row carries. If a genuinely conflicting dual-interest case appears, revisit with a follow-up ADR rather than pre-building for it.

**Rationale:** The scoping that matters (branded emails, enrichment fields, admin queue filter, and now D3's auto-join target) already hangs off `clientId`. A second table would duplicate the anti-enumeration, hygiene, and suppression machinery for no current product need.

### D6. What this ADR rejects

- **Org-less per-user app grant** (a new `UserAppGrant` table with no org): conceptually cleaner for consumer apps, but it forks the admission path — `validateNativeAuthorizationAdmission`, `listNativeAuthorizedTenants`, the app-switcher, and every ADR-010 consumer would need a second, org-free branch, and operator tooling would need a new surface to manage the grants. The designated-org model reuses all of it unchanged. Recorded as rejected, not deferred: if a future consumer app cannot tolerate a registry org, that ADR supersedes this section.
- **Billing/subscription hooks**: out of scope. Nothing in Engram models plans today; a paid consumer tier is its own ADR.
- **Multiple waitlist rows per email** (per D5).

## Considered Options

### A. Designated-org auto-join on the existing admission path (CHOSEN)

One nullable column, two transactional call sites (approve, register/OAuth-signup), zero changes to the admission check or any consumer app.

### B. Org-less user-level grant primitive

New entitlement table + second admission branch + operator surface. Rejected per D6 — high blast radius for the same user-visible outcome.

### C. Per-product waitlist tables

Rejected per D5 — duplicates intake machinery; the `clientId` tag already provides the product lane.

## Consequences

### Positive

- Tradepost's public-launch gate (Tradepost ADR-003) reduces to: ship this ADR's implementation, create/verify the `tradepost` registry org per environment, flip `tradepost-web.signupMode = "open"`.
- Waitlist approval becomes a complete admission action for consumer lanes — no orphaned approved-but-unadmittable users.
- The next consumer app onboards by registering a `NativeAuthClient`, creating its registry org, and setting `autoJoinOrgSlug` — no schema or admission-path work.
- Suite posture is untouched: every suite client remains waitlist-gated, invitation-only (ADR-015).

### Negative

- Registry orgs stretch the `Organization` abstraction — operator surfaces must not confuse them with tenants (D2 badging/pagination), and org-member counts become unbounded.
- `signupMode=open` on a consumer client widens the abuse surface (bot signups into the registry org). Mitigations: existing per-IP/per-email rate limits, email hygiene/suppression checks, provider-verified-email requirement on the OAuth path; CAPTCHA/turnstile if pressure appears.
- The one-row-per-email waitlist tradeoff (D5) is now a documented product decision rather than an accident.

### Risks

- **Misconfigured `autoJoinOrgSlug`** (missing org, unentitled app) would break consumer signup while suite flows look healthy. Mitigate with an admin/startup validation check and a test asserting the seeded `tradepost-web → tradepost` mapping resolves.
- **OAuth clientId-context smuggling** — if the consumer-client context on the callback were client-controlled, any visitor could mint accounts into the registry org while the client is still `waitlist`. D4 pins the context to server-side OAuth `state`.
- **Drift with ADR-015** — ADR-015 should gain an amendment note pointing here when this ADR is accepted, so its "no public self-service" statement reads as suite-scoped.

## Implementation notes (for the follow-up implementation PR/goal)

- Schema: `NativeAuthClient.autoJoinOrgSlug String?` — additive migration + seed for `tradepost-web`. Migration PRs require human approval (suite guardrail, cortex ADR-128).
- Touch points: `src/app/api/admin/waitlist/approve/route.ts` (D3), `src/app/api/auth/register/route.ts` (D4), OAuth callbacks + authorize `state` plumbing (D4), `src/lib/native-auth.ts` or a small `consumer-clients.ts` helper (`resolveConsumerClient(clientId)`), admin console badge for registry orgs (D2).
- Per-environment ops: ensure a `tradepost` org exists with the `tradepost` `OrgAppEntitlement` enabled on aws-dev and aws-prod before flipping `signupMode`.
- Tests: approve-with-clientId joins the org; approve-suite-lane does not; register 403 stays for waitlist clients; open-mode register + OAuth signup auto-join; unknown OAuth outside consumer-open context still redirects to waitlist (ADR-015 regression guard).

## Links

- ADR-015: Invitation-only admission and waitlist — `docs/adr/ADR-015-invitation-only-admission-and-waitlist.md`
- ADR-016: Native PKCE auth-code issuance — `docs/adr/ADR-016-native-pkce-auth-code-issuance.md`
- ADR-018: Tradepost native client — `docs/adr/ADR-018-tradepost-native-client.md`
- Tradepost ADR-003: Tenancy model — `../../tradepost/docs/adr/003-tenancy-model.md`
- Meta playbook consumer-app branch (companion change) — `../../docs/runbooks/new-app-playbook.md`
