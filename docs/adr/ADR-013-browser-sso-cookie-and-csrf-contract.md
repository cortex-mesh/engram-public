# ADR-013: Browser SSO Cookie, Logout, and CSRF Contract

**Status:** Proposed
**Date:** 2026-05-20
**Deciders:** Roland
**Related:** ADR-001 (Engram identity service), ADR-003 (Tenant Workspace Domains and Product Routing), ADR-007 (Nexus as the Tenant Workspace Consumer), ADR-010 (Consumer App Admission Pattern), `docs/security-audit-2026-05-20.md`, `docs/suite-auth-consumer-audit-2026-05-20.md`

## Context

Engram provides browser SSO for the hosted suite. Consumer apps rely on Engram cookies and local JWT validation:

- Nexus, Synapse, Thoughts, Pulse, and Plexus all depend on the `engram-access` cookie reaching their host/path.
- Synapse also uses `engram-access` for WebSocket auth.
- Consumers do not read `engram-refresh`; refresh remains Engram-owned.
- Nexus and Synapse have logout flows that POST to Engram `/api/auth/logout` with cookies.

The May 2026 audit found two related issues:

1. Some Engram cookie-authenticated mutation routes lack robust CSRF protection.
2. Engram logout clearing may not include the configured cookie domain, so domain-scoped SSO cookies can survive logout.

The suite needs a stable cookie and logout/CSRF contract before tightening enforcement.

## Decisions

### D1. The `engram-access` browser SSO cookie is a stable suite contract

**Decision:** Engram commits to the following browser SSO access-cookie contract unless superseded by a future ADR:

- Name: `engram-access`
- Contains: Engram access JWT with `type: "access"`
- Path: `/`
- Domain: configured parent suite domain when `ENGRAM_COOKIE_DOMAIN` is set; host-only otherwise
- `httpOnly: true`
- `secure: true` in production
- `sameSite: "lax"`

Consumers may read the cookie server-side for local JWT verification. Browser JavaScript must not read it.

### D2. The `engram-refresh` cookie remains Engram-owned

**Decision:** Consumer apps must not depend on reading `engram-refresh`.

Refresh cookie contract:

- Name: `engram-refresh`
- Path: `/api/auth`
- Domain follows Engram cookie domain configuration
- `httpOnly: true`
- `secure: true` in production
- `sameSite: "lax"`

Consumers renew sessions by redirecting/navigating to Engram flows such as `/api/auth/continue`, not by reading refresh tokens directly.

### D3. Cookie scope changes require suite-wide migration

**Decision:** Engram must not change cookie names, domain, path, or SameSite behavior in a routine hardening PR.

Any such change requires:

- consumer audit update;
- staged rollout plan;
- explicit backwards-compatibility period;
- smoke tests for Nexus, Synapse, Thoughts, Pulse, and Plexus.

### D4. Logout must clear the exact cookies Engram sets

**Decision:** Engram logout must clear access and refresh cookies using matching domain/path/SameSite/secure attributes.

If `ENGRAM_COOKIE_DOMAIN` is set, Engram must clear the domain-scoped cookie, not only a host-only cookie.

Consumers may also clear known cookie variants locally for defense in depth, but Engram owns authoritative logout.

### D5. CSRF protection applies to cookie-authenticated unsafe methods

**Decision:** Engram will enforce CSRF protection on cookie-authenticated unsafe methods.

Unsafe methods include POST, PUT, PATCH, and DELETE.

The CSRF policy must distinguish auth transport:

- Cookie-authenticated browser requests require CSRF protection.
- Bearer-token API requests are not subject to browser CSRF token requirements.
- Internal/service requests require their own explicit auth and must not be accidentally accepted as browser cookie writes.

### D6. Logout requires a compatibility contract before strict CSRF enforcement

**Decision:** Engram must provide a logout path that remains usable by Nexus and Synapse before strict CSRF enforcement is applied to logout.

Acceptable options include:

1. A top-level Engram logout redirect endpoint that clears cookies during browser navigation.
2. A CSRF token acquisition endpoint and documented POST flow.
3. A server-to-server logout credential/path for consumer BFF routes.

The chosen logout compatibility path must be implemented before `/api/auth/logout` rejects existing Nexus/Synapse logout calls.

### D7. `/api/auth/continue` remains the browser session handoff path

**Decision:** Consumer apps may continue to redirect or navigate users to Engram `/api/auth/continue?redirect_uri=...` for browser session handoff.

Changing this route requires a migration plan because Nexus, Synapse, Pulse, and Plexus use it for login or session recovery.

## Considered Options

### Option A — Preserve cookie contract and add CSRF/logout compatibility (chosen)

Pros:

- Hardens Engram without breaking existing SSO.
- Gives consumers a stable target.
- Allows CSRF protection to be rolled out safely.

Cons:

- Requires careful transport distinction in auth helpers.
- Logout needs explicit compatibility work.

### Option B — Replace shared cookies with bearer-only auth

Pros:

- Avoids browser CSRF for most app interactions.
- Makes auth transport explicit.

Cons:

- Breaks current browser SSO model.
- Forces token handling into browser/client code or BFF token exchange.
- Large migration across every app.

Rejected for current hosted suite browser auth.

### Option C — Keep Origin-only CSRF checks

Pros:

- Minimal code change.
- No consumer changes.

Cons:

- Missing-Origin behavior is brittle.
- Does not provide a robust token-based CSRF defense.
- Cross-subdomain SSO increases the importance of clear CSRF boundaries.

Rejected as a long-term defense.

## Consequences

### Positive

- Consumer apps have a stable cookie contract.
- Engram can harden CSRF without breaking suite logout unexpectedly.
- Logout becomes authoritative and reliable for parent-domain cookies.

### Negative

- Cookie scope remains a cross-suite coupling.
- CSRF rollout requires coordination with Nexus and Synapse logout behavior.

### Risks

- If CSRF is enforced on logout before compatibility work, Nexus/Synapse users may appear logged out locally while Engram cookies survive.
- If cookie SameSite/domain/path changes are bundled into unrelated fixes, suite login can fail broadly.

Mitigation: keep cookie-scope changes out of routine hardening PRs and follow the roadmap Phase 3 rollout.

## Rollout

See `docs/roadmaps/2026-05-engram-auth-hardening.md` Phase 3.

## Links

- `docs/security-audit-2026-05-20.md`
- `docs/suite-auth-consumer-audit-2026-05-20.md`
- `docs/roadmaps/2026-05-engram-auth-hardening.md`
