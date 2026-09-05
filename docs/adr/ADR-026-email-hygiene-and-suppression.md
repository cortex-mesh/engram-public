# ADR-026: Email Hygiene, Provider Suppression, and Sender-Reputation Protection

- **Date:** 2026-07-14
- **Status:** Proposed

## Context

Engram is the only sender of transactional mail for the suite: waitlist
confirmations, waitlist-approval set-password links, magic-link sign-ins,
verify-email links, and set-password links (ADR-015, ADR-017). Every one of
these flows is the way Engram *proves account ownership* — a link delivered to
an address the user controls. If Engram cannot deliver, the whole
invitation-only admission model (ADR-015) stalls.

Today the only gate before Engram agrees to send is a **regex** on the address
shape (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`). That regex accepts:

- addresses at **non-existent or non-mail domains** (no MX, no A/AAAA) — these
  hard-bounce;
- addresses at **disposable / throwaway domains** — high complaint and bounce
  rates, near-zero legitimate signal;
- addresses that have **already hard-bounced or filed a spam complaint** — every
  resend to them compounds the damage.

This is now urgent because the newest sending identity,
**`ccgtradepost.com`**, is a **brand-new domain with zero sender reputation**.
Mailbox providers weight bounce rate and complaint rate heavily for young
domains; a burst of hard bounces or a handful of "mark as spam" clicks in the
warm-up window can land the domain in a spam-folder or block state that takes
weeks to recover, degrading delivery for *every* tenant that shares the sender.
Resend itself will pause or restrict an account whose bounce/complaint rates
cross their thresholds.

Resend delivers per-message outcome events (`email.delivered`,
`email.bounced`, `email.complained`) as **Svix-signed webhooks**, but Engram
does not consume them, so it has no memory of a bad address and will resend to it
on the next waitlist re-request, magic link, or approval.

Two hard constraints shape the design:

1. **No new external dependency for validation.** We will not add a paid
   real-time email-validation API (cost, privacy of leaking every prospect's
   address to a third party, and a new runtime failure mode on the critical
   admission path). Validation must use only DNS (which we already do for the
   platform) and a **vendored** static blocklist.
2. **The audit N-2 constant-time / generic-response contract must hold.** The
   public waitlist endpoint must not become an account- or validity-enumeration
   oracle: a rejected, suppressed, already-registered, and freshly-accepted
   address must all return the **same public `202`** in the **same wall-clock
   time**. Any per-address reason lives only in the authenticated admin surface.

A parallel change, **PR #168**, introduces a queued email path (a durable job +
consumer) with a **direct-mode fallback** when the queue is unavailable. Any
suppression gate we add must be enforced on **both** legs of that transition, or
the queue becomes a hole that resends to suppressed addresses.

## Decision

Engram adopts a two-layer email-hygiene model — **pre-send validation** at
intake and **provider-driven suppression** as durable state — with a single
choke point that *every* send path must pass through.

### 1. Provider suppression is durable state: `EmailSuppression`

Add an `EmailSuppression` table keyed by **normalized email** (`trim().toLowerCase()`,
unique), migration `0020_email_hygiene`:

```
EmailSuppression {
  id                cuid  @id
  email             String @unique      // normalized
  reason            String              // "bounced" | "complained"
  source            String              // e.g. "resend_webhook"
  eventType         String?             // raw provider event type
  providerMessageId String?
  rawEvent          Json?               // provider payload for forensics
  createdAt, updatedAt
  @@index([reason, updatedAt])
}
```

Writes are **upserts** (`suppressEmailAddress`) keyed on the normalized email, so
repeated bounce/complaint events for the same address are idempotent and always
reflect the latest event. Reads (`getEmailSuppression`) normalize the address the
same way. Both live in `src/lib/email-suppression.ts`, the single module every
send path imports.

### 2. Resend signed webhooks populate suppression

A new route `POST /api/webhooks/resend` (`src/app/api/webhooks/resend/route.ts`)
consumes `email.bounced`, `email.complained`, and `email.delivered`:

- **Signature verification is mandatory and fails closed.** The route reads the
  **raw request body** (`request.text()`, never a re-serialized JSON object) and
  verifies the Svix headers (`svix-id`, `svix-timestamp`, `svix-signature`)
  against `RESEND_WEBHOOK_SECRET` via Resend's `webhooks.verify`. A missing
  secret returns `503` (fail closed, not "accept unsigned"); an invalid/absent
  signature returns `400`. No unverified payload ever reaches the database.
- `email.bounced` → suppress with reason `bounced`; `email.complained` →
  suppress with reason `complained`. Both are **permanent** for our purposes:
  once recorded, the address is **never mailed again** until an operator removes
  the row. `email.delivered` is accepted and acknowledged (it is a subscribed
  event and a positive-reputation signal) but writes no suppression.
- Recipients are extracted defensively (string or array `to`), the provider
  `email_id`/`id` is stored as `providerMessageId`, and the full event is stored
  as `rawEvent` for forensics.
- The handler **logs** every suppression update (`console.warn` with type,
  count, message id) — no silent state change.

Bounce classification note: Resend does not split hard/soft bounces into distinct
event types on `email.bounced`; we treat the bounced event as suppressing.
Because the address can be un-suppressed by an operator (§7), a rare
soft-bounce false-positive is recoverable, and protecting a brand-new domain's
reputation is worth erring toward suppression.

### 3. Suppression is checked before *every* send — one choke point

`sendEmailBestEffort` and `sendEmailRequired` in `src/lib/email.ts` both call
`getEmailSuppression(to)` **before** handing anything to the provider:

- `sendEmailBestEffort` (fire-and-still-awaited best-effort sends, e.g. waitlist
  confirmation): if suppressed, it **logs and returns without sending** — no
  throw, because best-effort callers must still complete their response.
- `sendEmailRequired` (sends whose failure must surface, e.g. approval
  set-password): if suppressed, it **logs and throws** so the caller sees the
  failure rather than silently believing mail went out.

Because both provider-send helpers gate internally, **any** current or future
caller inherits the check for free. This is the invariant: *no code path reaches
`resend.emails.send` without passing `getEmailSuppression` first.*

**PR #168 transition (explicit requirement).** When PR #168 lands the queued
path:

- the **direct-mode fallback** (used when the queue is unavailable) must send by
  calling these same helpers — never a raw `resend.emails.send` — so it inherits
  the suppression gate; and
- the **queue consumer** must call `getEmailSuppression` **immediately before the
  provider send**, not only at enqueue time. An address can be suppressed by a
  bounce/complaint webhook *between* enqueue and dequeue; checking only at
  enqueue would let a job that was clean when queued deliver to an
  address that has since hard-bounced. The check at send time is the
  authoritative one; an enqueue-time check is an allowed optimization, not a
  substitute.

### 4. Pre-send validation at signup: MX-with-fallback + disposable blocklist

`validateSignupEmail` (`src/lib/email-hygiene.ts`) runs at intake and returns one
of `accepted`, `rejected_disposable`, or `rejected_no_dns`:

1. **Disposable-domain blocklist (vendored).** The domain is checked against a
   static list vendored at `src/data/disposable-email-domains.txt` (~8,000
   domains, from the community `disposable-email-domains` list). It is
   `readFileSync`-loaded once and cached in-process. **Runtime code never fetches
   it** — updating the list is a deliberate code change and PR, not a network
   call. No paid third-party validation API is used anywhere.
2. **DNS deliverability, fail-open.** Resolve `MX` for the domain; if present,
   accept. If no MX, fall back to `A` (`resolve4`) then `AAAA` (`resolve6`),
   matching real-world SMTP behavior where a host with an address record but no
   MX still accepts mail. If neither exists → `rejected_no_dns`.
3. **Transient DNS failures fail open.** `ETIMEOUT`, `ESERVFAIL`, `EAI_AGAIN`,
   and `ECONNREFUSED` are treated as *unknown, not invalid*: the address is
   **accepted and the event logged** (`console.warn`, "failed open"). A flaky
   resolver must never block a legitimate signup or turn into a self-inflicted
   outage on the admission path. Only an **authoritative negative** (NXDOMAIN /
   no records) rejects.

### 5. Waitlist intake stays generic and constant-time (audit N-2 preserved)

`POST /api/waitlist` runs validation and suppression **without ever changing its
public response**. All of these branches return the identical
`successResponse()` (`202`, generic message) and each `await settleAfter(startedAt)`
to the shared wall-clock floor before returning:

- address already has a `User` → no confirmation sent (unchanged prior
  behavior);
- `validateSignupEmail` returns `rejected_disposable` / `rejected_no_dns` →
  request is still **recorded** on the waitlist with
  `emailHygieneStatus`/`emailHygieneReason`/`emailHygieneCheckedAt` and
  `confirmationEmailSuppressedAt` set, but **no mail is sent**;
- `getEmailSuppression` hits → request updated to `emailHygieneStatus =
  "suppressed"` with the reason, **no mail sent**;
- accepted → confirmation sent via `sendEmailBestEffort` (which re-checks
  suppression as the choke point).

The rejected/suppressed address gets the **same public `202`** as an accepted
one; the *reason* is persisted on the `WaitlistRequest` row for admins only. This
keeps the endpoint from being a validity- or existence-oracle while still giving
operators full visibility. IP- and email-keyed rate limits and the constant-time
floor remain in force.

### 6. No silent drops — admins see suppression and hygiene state

`WaitlistRequest` gains `emailHygieneStatus` (default `"accepted"`),
`emailHygieneReason`, `emailHygieneCheckedAt`, and `confirmationEmailSuppressedAt`,
plus an `@@index([emailHygieneStatus, createdAt])`. The admin waitlist queue
(`listAdminWaitlistRequests` + `admin-waitlist-queue.tsx`) joins each request to
its `EmailSuppression` row and renders, per request, one of:

- **Suppressed: `<reason>` (`<eventType>`)** — provider bounce/complaint;
- **Email blocked: `<reason>`** — disposable / no-DNS at intake;
- **Confirmation not sent** — confirmation was withheld.

Rows that are suppressed or not `accepted` are **not selectable** for approval in
the UI, and the approve endpoint enforces the same server-side.

### 7. Approval and open registration reject at the gate

- **Approval** (`POST /api/admin/waitlist/approve`): before provisioning each
  selected request, it re-reads `getEmailSuppression` and the row's
  `emailHygieneStatus`. If the address is suppressed or not `accepted`, it
  updates the row with the current reason and returns `409` ("a selected request
  has a blocked email address") — an operator cannot approve their way into
  mailing a known-bad address. Un-suppression is a deliberate operator action
  (delete the `EmailSuppression` row) — there is no automatic un-suppress.
- **Open registration** (`POST /api/auth/register`): because this path *creates a
  user* rather than sending to a chooser-supplied address, it may **reject
  generically before creating the user**. It runs `validateSignupEmail` and, on
  non-`accepted`, returns the same generic `400` ("a valid email and password are
  required") it already returns for a bad password — no user row, no
  verification mail, no distinct error that discloses why.

### 8. Migration governance

Migration `0020_email_hygiene` touches `prisma/migrations/**` and therefore is
gated by the **cortex ADR-128 `migration-guard`** required check: it cannot merge
until **@rolme (Roland)** — or another human — approves. The migration file
carries an in-file note to that effect. The number `0020` intentionally follows
the reserved `0019_waitlist_soft_hide` migration so this branch stays
strictly monotonic under ADR-128.

## Consequences

### Positive

- **Sender reputation is protected at both ends:** bad addresses are refused
  *before* the first send (validation) and never re-sent to *after* a bad outcome
  (suppression). This directly defends the young `ccgtradepost.com` domain and
  every tenant that shares Engram's sender.
- **One choke point.** Every existing and future send inherits the suppression
  check by construction, including PR #168's queue consumer and its direct-mode
  fallback.
- **No new paid dependency and no prospect-data leakage** to a third-party
  validator; DNS and a vendored list only.
- **Operators keep full visibility** — every withheld send is logged and surfaced
  in the admin queue with a reason. Nothing is dropped silently.
- **Audit N-2 holds.** The public surface stays generic and constant-time; the
  reasons live only behind admin auth.

### Negative / trade-offs

- **Fail-open DNS** accepts some addresses at momentarily-unresolvable domains.
  This is deliberate: a resolver blip must not block the critical admission
  path. Those addresses that truly cannot receive mail will hard-bounce once and
  then be suppressed by the webhook — the second layer catches what the first
  lets through.
- **Bounce is treated as permanent-until-operator-action**, so a rare soft-bounce
  can over-suppress. Mitigated by operator un-suppression (§7) and justified by
  the asymmetric cost (a young domain's reputation vs. one recoverable
  false-positive).
- **Vendored blocklist goes stale** between updates; new disposable domains slip
  through until the list is re-vendored. Accepted: the suppression layer still
  catches the resulting bounces/complaints, and a runtime fetch (the alternative)
  is a rejected dependency and failure mode.
- **New public webhook endpoint** is attack surface; mitigated by mandatory
  fail-closed Svix signature verification (§2).

## Security Reasoning

- **Fail-closed webhook trust.** Suppression is security-relevant state (it can
  *block* a user's mail). It is only ever written from a **signature-verified**
  Resend event over the **raw body**; an unsigned or mis-signed request is
  rejected (`400`), and a mis-configured secret rejects everything (`503`). An
  attacker cannot forge a bounce to deny-of-service a victim's sign-in without
  the shared `RESEND_WEBHOOK_SECRET`.
- **No enumeration oracle.** The waitlist endpoint returns identical status and
  timing for accepted / rejected / suppressed / already-registered addresses
  (§5, audit N-2). Registration rejects with the *same* generic error it uses for
  other bad input, so hygiene rejection is not a distinguishable signal (§7).
- **Reason disclosure is authenticated-only.** Concrete reasons (disposable,
  no-DNS, bounced, complained) live on `WaitlistRequest`/`EmailSuppression` and
  are shown only in the superadmin console, never in a public response.
- **Availability of the admission path is preserved.** DNS validation fails
  open and is time-bounded by the existing send budget; a resolver or provider
  problem degrades to "send anyway / suppress later," never "block all signups."
- **Least privilege on un-suppression.** Removing a suppression is a manual DB
  operator action, not something the approval UI or any request path can do
  implicitly.

## Test / Mutation-Test Plan

**Unit — `email-hygiene`** (`tests/lib/email-hygiene.test.ts`):

- accepts a domain with MX; accepts A-only and AAAA-only fallback domains;
- rejects a domain with no MX and no address record (`rejected_no_dns`);
- rejects a vendored disposable domain (`rejected_disposable`) — with a mocked
  list so the assertion is stable;
- **fails open** on each transient code (`ETIMEOUT`, `ESERVFAIL`, `EAI_AGAIN`,
  `ECONNREFUSED`) and logs;
- malformed address (no/empty domain) → `rejected_no_dns`.

**Unit — suppression + send choke point** (`tests/lib/email-send.test.ts`):

- `sendEmailBestEffort` to a suppressed address does **not** call the provider,
  logs, and returns normally;
- `sendEmailRequired` to a suppressed address **throws** and does not call the
  provider;
- non-suppressed address reaches the provider exactly once;
- normalization: suppression stored as `USER@Example.com ` matches a send to
  `user@example.com`.

**Route — webhook** (`tests/api/resend-webhook.test.ts`):

- valid signature + `email.bounced`/`email.complained` upserts suppression with
  the right reason/message-id;
- `email.delivered` acks with `suppressed: 0` and writes nothing;
- **invalid signature → `400`, no DB write**; **missing secret → `503`**;
- array vs. string `to`; repeated event is idempotent (upsert, single row).

**Route — waitlist generic/constant-time** (`tests/api/waitlist.test.ts`):

- accepted, disposable-rejected, no-DNS-rejected, suppressed, and
  already-registered all return the **same `202` body**;
- disposable/no-DNS/suppressed paths **send no mail** but **persist** the
  hygiene/suppression reason on the row;
- `settleAfter` is awaited on every branch (timing floor holds).

**Route — approve & register** (`tests/api/admin-waitlist-approve.test.ts`,
`tests/api/auth/register.test.ts`):

- approving a suppressed or non-`accepted` request → `409`, no user created,
  reason written back;
- register with a disposable/no-DNS address → generic `400`, no user, no mail.

**Mutation-test plan** (Stryker on `email-hygiene.ts`, `email-suppression.ts`,
`email.ts` send helpers, and the webhook route). These mutants **must be killed**
— if any survives, coverage is inadequate:

- flip the transient-error branch (fail-open → fail-closed) — the fail-open tests
  must catch it;
- negate the suppression guard in `sendEmailBestEffort`/`sendEmailRequired`
  (`if (suppression)` → `if (!suppression)` / remove) — must be killed by the
  "does not call provider" tests;
- short-circuit signature verification (always-accept) — must be killed by the
  invalid-signature `400` test;
- swap `email.delivered` into the suppressing set — must be killed by the
  "delivered writes nothing" test;
- drop the `normalizeEmailAddress` call — must be killed by the
  mixed-case/whitespace normalization tests;
- change the MX-then-A-then-AAAA order / remove the AAAA fallback — must be
  killed by the A-only / AAAA-only acceptance tests;
- replace a rejection branch's response with a non-`202`/reason-bearing response
  — must be killed by the constant-generic-response tests.

## Operational Requirements

- **Env / secrets.** `RESEND_WEBHOOK_SECRET` must be set in every environment
  that runs the webhook (aws-dev, aws-prod, on-prem). It is added to
  `.env.example` and threaded through the CDK/deploy config the same way
  `EMAIL_VERIFIED_DOMAINS` was (PR #166). If it is unset the endpoint fails
  closed (`503`) and **no suppressions are recorded** — treat an unset secret as
  a reputation incident, not a benign default.
- **Resend configuration.** Register the webhook endpoint
  (`https://login.dev.ctxhost.com/api/webhooks/resend` and the prod/on-prem
  equivalents) in the Resend dashboard subscribed to `email.bounced`,
  `email.complained`, and `email.delivered`, using the same signing secret.
- **Migration.** `npx prisma migrate deploy` applies `0020_email_hygiene` as the
  manifest-declared one-shot before the new container starts (per the Engram
  deploy flow). Merge is blocked until Roland/ADR-128 approval.
- **Monitoring / alerting.** Alert on the webhook's `503`/`400` rates (a spike
  means a broken secret or a spoofing attempt) and on the **suppression growth
  rate** by reason — a sudden rise in `bounced`/`complained` is an early warning
  that the domain's reputation is degrading. Watch the "failed open" DNS log line
  for resolver problems.
- **Runbook — un-suppression.** To re-enable a wrongly-suppressed address, an
  operator deletes the `EmailSuppression` row for the normalized email (and, if
  it was a waitlist request, clears the hygiene fields). There is deliberately no
  self-serve or automatic un-suppress.
- **List maintenance.** Re-vendoring `disposable-email-domains.txt` is a periodic
  PR (diff-reviewed), never a runtime fetch.
- **PR #168 checklist.** When the queue lands, verify by test that (a) the
  direct-mode fallback routes through `sendEmailBestEffort`/`sendEmailRequired`,
  and (b) the consumer calls `getEmailSuppression` at **send time**. Ship neither
  leg without its suppression assertion.

## Related

- **ADR-015** — Invitation-only admission and waitlist intake (the flows this
  protects).
- **ADR-017** — Verified-email set-password flow (a suppression-gated sender).
- **Audit N-2** — waitlist generic/constant-time response contract (preserved
  here); see `docs/security-audit-*.md`.
- **cortex ADR-128** — migration-guard human approval for `prisma/migrations/**`.
- **PR #166** — `EMAIL_VERIFIED_DOMAINS` deploy wiring (pattern followed for
  `RESEND_WEBHOOK_SECRET`).
- **PR #168** — queued email path + direct-mode fallback (must honor the §3
  choke point).
