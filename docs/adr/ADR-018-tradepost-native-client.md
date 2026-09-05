# ADR-018: Tradepost Native PKCE Client

- **Status**: Accepted
- **Date**: 2026-06-11
- **Builds on**: ADR-002 (native client authentication), ADR-013 (browser SSO
  cookie), ADR-016 (auth-code admission)

## Context

Tradepost (cortex-mesh/tradepost, ADR-003 there) is the suite's first
dedicated-product-host app: `tradepost.dev.ctxhost.com`, anonymous-first,
with Engram as its identity provider. It needs sign-in for collections and
deck editing. Tradepost is NOT an org-tenant app — Engram supplies identity
only; authorization inside Tradepost is per-user ownership.

## Decision

Register a first-party public PKCE client, following the synapse-native
pattern (migration 0009):

- `NativeAuthClient`: `clientId=tradepost-web`, display name "Tradepost".
- Redirect URIs (exact-match): the dev and prod product hosts'
  `/auth/callback`, plus `http://localhost:3000/auth/callback` for local dev.
- `AppKey` gains `tradepost`; `NATIVE_CLIENT_APP_BINDINGS` binds
  `tradepost-web → tradepost` (ADR-016 admission applies unchanged).
- The demo-tenant seed gains the `tradepost` entitlement so `demo-owner` /
  `demo-member` can sign in on aws-dev (the canonical hosted test users).

Org admission semantics are unchanged: for now Tradepost sign-in rides org
app entitlements like every other app. The ADR-003 "self-serve signup
auto-joining a tradepost org" model is a future, separate ADR — it gates
Tradepost's public launch, not development.

## Consequences

- Browser SSO (ADR-013, `.dev.ctxhost.com` cookie) gives silent auth-code
  issuance for users already signed in at login.dev.ctxhost.com.
- Tradepost holds its own session (token exchange server-side); Engram
  refresh-token rotation applies as for any native client.
