# ADR-002: Native Client Authentication

**Status:** Accepted
**Date:** 2026-04-10
**Last Updated:** 2026-05-26
**Deciders:** Roland
**Related:** ADR-001 (Engram — Centralized Identity & Authentication Service), ADR-015 (Invitation-Only Admission and Waitlist Intake), ADR-016 (Native PKCE Authorization Code Issuance for Entitled Invited Users), Synapse ADR-001 (Synapse — CORTEX Chat Client)

## Amendment Notes

- **2026-05-26:** ADR-016 amends Synapse Native to use identity-first `app=synapse` authorization without a preselected tenant. Token exchange returns the Engram-approved tenant hosts for the authenticated user; tenant-scoped native authorization remains supported for fixture/debug paths.
- **2026-05-21:** ADR-016 extends this native PKCE contract with phase-one org/app admission requirements for tenant-scoped code issuance and permits an operator-only dev/test auth-code fixture that creates real short-lived codes for approved users without minting tokens directly.
- **2026-04-28:** Implemented the first reusable native-client substrate:
  database-backed native client and redirect URI registration, `/authorize`,
  `/api/auth/token`, single-use hashed authorization codes, S256 PKCE
  validation, and native body transports for refresh/logout. Broca is expected
  to become a registered client rather than a special-case auth path.
- **2026-04-29:** Added `prompt=login` handling for native `/authorize`
  requests so a client that explicitly signed out can force the next login UI
  instead of silently resuming an existing Engram browser cookie.

## Context

ADR-001 established Engram as the centralized identity and authentication service for the CORTEX suite. That decision covered web SSO via shared-domain cookies and Bearer-token fallback for non-browser clients, but it did not fully specify how first-party native clients should authenticate.

This ADR refines ADR-001 for first-party native clients. Where ADR-001 described a generic non-browser Bearer-token fallback and redirect-based login flow, this ADR defines the concrete native-client contract: authorization code, PKCE, registered client callbacks, and Engram-owned token exchange.

Synapse is the first consumer that needs a concrete native-client flow. ADR-001 and Synapse ADR-001 both describe a future iOS/mobile client. A native app cannot depend on shared-domain cookies the way browser-based apps do, and it needs a secure token acquisition and refresh flow that works with Keychain storage, app callbacks, and background/foreground session continuity.

The native authentication design must satisfy the following constraints:

- Engram remains the single source of truth for login, registration, OAuth, password reset, and account management
- Native clients must not collect credentials on behalf of consuming apps like Synapse
- Native clients must not depend on browser cookies for ongoing API access
- Access to consuming apps should still use the same Engram-issued JWT model as web
- The flow should scale to future native clients beyond Synapse iOS
- The design should avoid introducing a separate auth protocol just for mobile

## Decisions

### 1. Native Clients Use Authorization Code + PKCE

**Decision:** First-party native clients authenticate with Engram using an authorization-code flow with PKCE. The native app opens Engram's login UI in the system browser or platform-native authentication session, receives a short-lived authorization code at a registered callback URI, and exchanges that code plus PKCE verifier for an access token and refresh token.

**Rationale:** PKCE is the standard secure pattern for public clients that cannot safely hold a client secret. It prevents authorization-code interception attacks, avoids teaching every consumer app how to handle credentials, and keeps Engram as the sole login surface. It also works cleanly with OAuth providers and magic-link completion inside Engram.

### 2. Web and Native Share One Identity System, but Use Different Session Transports

**Decision:** Engram uses the same user model, same authentication methods, and same JWT format for web and native clients. The difference is transport and storage:

- **Web:** shared-domain httpOnly cookies on `.rapidagent.dev`
- **Native:** Bearer access token in the `Authorization` header, refresh token stored securely on-device

**Rationale:** Identity should not fork by client type. A user authenticated via email/password, OAuth, or magic link is the same Engram identity regardless of whether they continue in Safari or in an iOS app. Keeping one token format preserves consumer simplicity while allowing native-appropriate storage and transport.

### 3. Native Tokens Are Stored in the Platform Secure Store

**Decision:** Native clients store refresh tokens in the platform secure store (Keychain on iOS). Access tokens may be kept in memory when practical, but if persisted they must also be stored in the platform secure store. Tokens must never be written to plaintext local storage, app preferences, or log output.

**Rationale:** Native apps do not have httpOnly cookie protection. The secure store is the platform-standard defense for long-lived credentials. This keeps the mobile threat model aligned with the security expectations of a central identity provider while allowing short-lived access tokens to be treated more flexibly in client implementations.

### 4. Native Clients Refresh Only Through Engram

**Decision:** Refresh-token rotation, reuse detection, and revocation remain Engram-only concerns. Native clients use Engram's refresh endpoint to obtain new token pairs. Consuming apps such as Synapse never issue or refresh tokens on behalf of native clients.

**Rationale:** Centralizing refresh behavior preserves one security boundary. Reuse detection, token-family invalidation, and logout semantics become inconsistent and error-prone if each consuming app is allowed to mint or rotate its own mobile tokens.

### 5. Engram Exposes Native Authorization and Code-Exchange Endpoints

**Decision:** Engram supports a native-app login flow with these route responsibilities:

| Route | Method | Purpose |
|-------|--------|---------|
| `/authorize` | GET | Starts login for a first-party native client, validates `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, and `state`; supports `prompt=login` to force login UI after explicit native sign-out |
| `/api/auth/token` | POST | Exchanges a single-use short-lived authorization code + exact `redirect_uri` + PKCE verifier for an access token and refresh token |
| `/api/auth/refresh` | POST | Rotates refresh token and returns a new token pair |
| `/api/auth/logout` | POST | Revokes the current refresh-token family and terminates the native session |

The existing Engram login methods (email/password, OAuth, magic link) remain internal implementation details behind `/authorize`.

**Rationale:** Native clients need an explicit initiation and code-exchange contract. Reusing Engram's existing auth methods behind the authorization endpoint avoids exposing separate login APIs per method to each native consumer while still using a standard, recognizable OAuth-style contract.

### 6. Engram Validates Redirect URIs Against Registered First-Party Clients

**Decision:** Engram maintains a registry of approved first-party clients and their allowed callback URIs. Only registered `client_id` + exact `redirect_uri` pairs are permitted for native authorization. The registry is data-backed so adding a future native app should require client registration, not auth code changes.

Where the platform supports claimed HTTPS callbacks (Universal Links / App Links), those are preferred over custom URI schemes. Custom schemes remain acceptable for first-party clients when operationally simpler, but they are treated as a tradeoff rather than the ideal.

Example first-party clients:

- `synapse-ios` → `https://auth.rapidagent.dev/synapse-ios/callback` or `synapse://auth/callback`
- `synapse-ios-dev` → `https://auth.rapidagent.dev/synapse-ios-dev/callback` or `synapse-dev://auth/callback`

**Rationale:** Redirect URI validation is mandatory for authorization-code security. A registered client list prevents open redirect abuse and keeps the native callback story explicit as more first-party apps are added. Preferring claimed HTTPS callbacks reduces the interception risk associated with custom URI schemes while still allowing a pragmatic first-party rollout path.

### 7. Consumer Apps Accept Bearer Access Tokens from Native Clients

**Decision:** Consuming applications validate Engram access tokens from the `Authorization: Bearer` header for native clients. They do not require shared-domain cookies in native scenarios.

**Rationale:** Browser cookie SSO is the right transport for web, but it is not the right transport for native apps. Bearer-token validation lets the exact same Engram-issued JWT authorize requests across native and non-browser environments.

### 8. Authorization Remains Layered

**Decision:** Engram continues to own authentication, identity, organization membership, and suite-level roles. Consuming applications continue to own resource-specific authorization.

Examples:

- **Engram-owned:** who the user is, what organizations they belong to, whether they are an org admin
- **Synapse-owned:** room membership, per-room visibility, thread/message permissions, chat-specific moderation rules

**Rationale:** Centralizing all authorization into Engram would tightly couple the identity service to application-specific resource models. The right split is centralized identity plus app-local authorization.

## Considered Options

### A. Shared-Domain Cookies Only

Require native apps to rely on Engram's browser cookies, either by embedding a web view or by depending on Safari session state for subsequent API calls.

**Rejected:** Cookies are the wrong primitive for ongoing native API access. They make session handling opaque, complicate app-restored state, and create brittle behavior outside the browser. Native clients need an explicit token model.

### B. Username/Password Login Directly From the Native App

Have the iOS app POST credentials directly to Engram's login endpoint and receive tokens without an authorization-code flow.

**Rejected:** This bypasses the cleaner identity-provider boundary and makes native clients too aware of low-level authentication details. It also complicates OAuth and magic-link completion, since those still require browser interaction. PKCE provides a more future-proof unified flow.

### C. Device Code Flow

Use a device-code flow where the app shows a code and the user completes login on another device/browser.

**Rejected:** This is useful for TVs and CLI tools, but adds unnecessary friction for a first-party iOS app that can open the system browser directly. It is worse UX than a normal browser-based sign-in flow.

### D. Separate Mobile Auth Service

Create a second auth surface just for native/mobile clients, distinct from Engram's web login and token issuance flows.

**Rejected:** This duplicates identity logic, splits the security model, and undermines the core reason Engram exists. One identity provider should serve all client types.

### E. Authorization Code + PKCE (CHOSEN)

Use an authorization-code flow with PKCE, registered first-party clients, Bearer access tokens for API calls, and refresh-token rotation handled centrally by Engram.

**Chosen because:** It is the standard secure pattern for public native clients, preserves Engram as the only identity provider, works with all Engram-supported login methods, and cleanly supports future native apps without inventing a custom mobile-only auth model.

## Migration Strategy

1. Add a first-party client registry in Engram for approved native clients and callback URIs
2. Implement `/authorize` and `/api/auth/token` with PKCE validation
3. Extend existing refresh/logout logic to support native token transport explicitly
4. Document native-client integration requirements for consuming apps
5. Update the first native consumer (Synapse) to rely on Bearer access tokens from Engram

## Consequences

### Positive

- Engram becomes the canonical login provider for both web and native apps
- Synapse iOS and future native clients can authenticate without inventing app-specific auth flows
- PKCE gives a strong, modern security posture for public clients
- Consumer apps stay simple: validate Engram JWTs, then apply local authorization
- OAuth and magic links continue to work naturally for native clients because they terminate in Engram

### Negative

- Engram gains additional complexity around client registration, callback validation, and code exchange
- More documentation is required so native clients implement the flow consistently
- Native session lifecycle testing becomes part of Engram's responsibility

### Risks

- **Misconfigured redirect URIs** — mitigated by strict first-party client registration and exact redirect-uri validation
- **Authorization-code interception** — mitigated by PKCE and short-lived single-use authorization codes
- **Refresh-token theft on device** — mitigated by Keychain storage, rotation, reuse detection, and remote revocation via Engram
- **Consumer inconsistency** — mitigated by keeping token issuance/refresh in Engram and defining one Bearer-token contract for native clients
