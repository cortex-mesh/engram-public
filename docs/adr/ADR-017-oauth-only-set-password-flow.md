# ADR-017: Verified-Email Set-Password Flow for OAuth-Only Accounts

**Status:** Proposed
**Date:** 2026-06-10
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-013 (Browser SSO Cookie & CSRF Contract), `docs/security-audit-2026-06-10.md` (#1 / HG-3), `docs/plans/2026-06-10-defense-in-depth-hardening.md` (D7)

## Context

HG-3 (security audit 2026-06-10) closed a CSRF/credential gap on
`change-password`: an OAuth-only account (no `passwordHash`) could set an
initial password from a live session with no proof of email control. Because
a session can be ridden (XSS, a borrowed device) and setting a password
establishes a **new persistent credential**, the endpoint now returns `409`
for OAuth-only accounts and tells the user to use "the email verification
flow."

That flow does not exist yet. Today an OAuth-only user has **no supported way
to add a password** — the 409 is a dead end. This ADR defines the flow.

The governing security requirement (from HG-3): establishing an initial
password must require **proof of email control at the moment of setting**, not
merely an authenticated session.

## Decision

Add a **purpose-tagged magic-link set-password flow**. The proof of email
control is a single-use, short-TTL email token that is consumed *at the
moment the password is set* — not at login.

### Mechanism

1. **Request.** From the account page, an OAuth-only user (or any user wanting
   to (re)set via email) triggers `POST /api/auth/set-password/request`.
   Engram issues a magic-link-style token with `purpose = "set_password"` and
   emails a link to `/<account>/set-password?token=…`. Same hardening as login
   magic links: `nanoid` token, SHA-256 hashed at rest, single-use, short TTL
   (15 min), rate-limited (reuses the existing limiter), generic response (no
   account-existence oracle).
2. **Landing.** `GET /set-password?token=…` renders a set-password **form**.
   It does **not** consume the token (so a mail scanner's prefetch can't burn
   it, consistent with D4/N-5).
3. **Set.** `POST /api/auth/set-password` with `{ token, newPassword }`
   atomically consumes the token (asserts `purpose = "set_password"`, unused,
   unexpired), sets `passwordHash`, marks `emailVerified = true`, and **revokes
   all refresh tokens** (force re-login everywhere), mirroring change-password.
   CSRF guard applies as for other cookie-auth mutations; bearer/native pass.

### Token model

Add a nullable `purpose` column to the existing `MagicLink` model
(default/login = `null` or `"login"`; set-password = `"set_password"`). The
consume helper takes an expected purpose and refuses a mismatch, so a
login link can never be replayed to set a password and vice-versa.

## Alternatives considered

- **Allow set-password from a live session (status quo before HG-3).**
  Rejected — that is exactly the credential-persistence vector HG-3 closed.
- **Reuse the login magic link unchanged, then allow set-password within a
  short post-login window.** Rejected — requires tracking "this session was
  born from a fresh magic link," i.e. session state in the JWT, and it
  consumes the proof at login rather than at set time (weaker; a hijacked
  post-magic-link session could set a password).
- **A separate `PasswordSetToken` model.** Functionally equivalent to a
  purpose tag; rejected for redundancy — `MagicLink` already has the exact
  hashing/TTL/single-use machinery, so a `purpose` column is the smaller,
  lower-drift change.
- **Step-up OAuth re-auth instead of email.** Heavier (full OAuth round-trip
  per provider) and email control is the property we actually need to prove;
  deferred unless a passwordless-but-also-OAuth-revoked edge case demands it.

## Consequences

- OAuth-only users gain a supported, phishing-resistant path to a password;
  the HG-3 409 message becomes truthful.
- One small migration (`MagicLink.purpose`). No consumer/contract change — the
  flow is entirely Engram-hosted (account page + Engram routes + Resend, which
  is already configured). No synapse-native change (native uses PKCE, not
  passwords).
- Slight surface growth (one new page + two routes); each carries the same
  rate-limit, CSRF, single-use, and audit-logging guarantees as the existing
  auth surface (`set_password` is audited via `recordAuditEvent`).
- Reuses `Resend` (already set up for magic links) — **no new infra**.
