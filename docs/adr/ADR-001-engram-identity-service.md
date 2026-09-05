# ADR-001: Engram — Centralized Identity & Authentication Service

**Status:** Accepted
**Date:** 2026-04-08
**Last Updated:** 2026-05-26
**Deciders:** Roland
**Related:** Synapse ADR-015 (User Authentication), Synapse ADR-014 (Organizations and Multi-Tenancy), ADR-005 (Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements), ADR-008 (Human Users and Agent Service Principals), ADR-015 (Invitation-Only Admission and Waitlist Intake), ADR-016 (Native PKCE Authorization Code Issuance for Entitled Invited Users)

## Amendment Notes

- **2026-05-26:** ADR-016 now allows identity-first Synapse Native login with `app=synapse` and no preselected tenant. Engram returns only approved tenant hosts during token exchange; tenant-scoped native auth still requires org/app admission before code issuance.
- **2026-05-21:** ADR-015 formalizes phase-one invitation-only admission and waitlist-only unknown-user behavior; ADR-016 refines ADR-002's native PKCE flow so tenant-scoped native authorization code issuance requires approved user/org/app admission and uses operator-only auth-code fixtures only for dev/test smoke.
- **2026-05-15:** On-prem suite navigation now uses `login.rapidagent.dev:8443` as the canonical Engram auth host, matching `login.dev.ctxhost.com` in aws-dev. `engram.rapidagent.dev` is a legacy/transitional alias and should not be used in new deployment config. Plexus is the operator console successor to the original Dashboard integration, while tenant navigation enters the suite through the tenant host such as `lab.rapidagent.dev:8443`.
- **2026-05-15:** Engram's normal deploy path is now `cortex app deploy engram --env <env>`. The manifest runs `npx prisma migrate deploy` as an in-image pre-deploy hook before replacing the running container.

## Context

The CORTEX product suite now has four web applications on on-prem-host:

| App | Port | Current Auth | Database |
|-----|------|-------------|----------|
| Dashboard | 3100 | NextAuth v5 (username+password, JWT) | SQLite |
| Synapse | 3101 | Custom JWT (email+password, OAuth, magic links) | PostgreSQL |
| Thoughts | 3102 | None / API key | PostgreSQL |
| Axon | 3103 | None / API key | Python + React |

Each application either has its own auth implementation or no real auth at all. Dashboard uses NextAuth with username+password only. Synapse has a comprehensive custom JWT system with OAuth and magic links (Synapse ADR-015). Thoughts and Axon rely on API keys. Users must create separate accounts per application, and there is no shared identity.

As the suite grows and new users join (Ryan, Ronan), this fragmentation becomes untenable:

- Users need separate credentials for each app
- OAuth provider configs (Google, GitHub) must be duplicated per app
- No way to share roles, organizations, or permissions across apps
- Adding auth to a new app means reimplementing the full auth stack
- A future SSO migration would require merging multiple user stores

### Current Dashboard Auth Stack (What Prompted This)

Dashboard's auth is the immediate pain point:

- **Library:** NextAuth v5 with Credentials provider only
- **Identity:** Username-based (no email, no OAuth, no magic links)
- **Session:** Stateless JWT, no refresh token rotation or revocation
- **Database:** SQLite (concurrency limitations, inconsistent with other apps)
- **User model:** `id`, `username`, `passwordHash`, `role`

Rather than replicate Synapse's auth into Dashboard (creating two independent user stores), a centralized identity service is the better investment.

## Decisions

### 1. Build Engram — A Dedicated Identity & Auth Service

**Decision:** Build Engram as a standalone Next.js application that owns all user identity, authentication, organization management, and waitlist intake for the CORTEX suite. All other applications (Dashboard, Synapse, Thoughts, Axon) become auth consumers — they validate JWTs locally but delegate login, waitlist handling, and account management to Engram.

**Rationale:** Synapse already has ~90% of the auth code needed (custom JWT with jose, OAuth, magic links, refresh token rotation). Extracting this into a standalone service is comparable effort to replicating it into Dashboard, but the outcome is architecturally superior: one user store, one set of OAuth configs, and every new app gets auth for free by validating JWTs.

### 2. Three Authentication Methods

**Decision:** Support email+password (primary), OAuth 2.0 (Google, GitHub), and magic links (passwordless email) for approved accounts. Self-service signup is disabled; prospective users join a waitlist instead of creating accounts directly. All successful auth methods still produce the same JWT. This keeps the authentication surface from Synapse ADR-015 while changing the admission policy.

**Rationale:** Email+password remains the baseline for approved users. OAuth reduces friction for approved Google/GitHub users, and magic links provide a passwordless option for existing accounts. Admission is now controlled separately through the waitlist so consuming applications still see one consistent JWT-based identity surface without opening self-service account creation.

### 3. JWT Session Tokens

**Decision:** Issue a short-lived access token (15 minutes) and a long-lived refresh token (30 days). The access token payload contains `{ userId, role, type: "access" }`. On the web, tokens are stored in httpOnly cookies. Refresh tokens are DB-backed for rotation and reuse detection.

**Rationale:** Short-lived access tokens limit the blast radius of token theft. DB-backed refresh tokens enable revocation and detect token reuse (possible theft). This matches Synapse's proven implementation.

> **Amended by ADR-031 (2026-07-22):** reuse detection now allows a short reuse-grace window — a token rotated within ~30 s is graced (benign concurrent/retry refresh) rather than revoking the family; reuse outside the window still revokes. Fixes forced re-login on every client deploy.

### 4. Cookie Strategy for Cross-App Auth

**Decision:** Engram sets auth cookies scoped to the shared domain when `ENGRAM_COOKIE_DOMAIN` is configured. On production `*.rapidagent.dev` subdomains, this enables shared-domain cookie SSO across Engram, Dashboard, and Synapse. When no cookie domain is configured (for example local development), Engram falls back to host-only cookies. Non-browser and native clients continue to use `Authorization: Bearer` access tokens.

Browser consumers should redirect to `ENGRAM_URL/api/auth/continue?redirect_uri=<app_url>` rather than directly to `/login`. The continue endpoint either (1) passes through immediately when a valid access cookie exists, (2) rotates via refresh cookie and then redirects back, or (3) falls back to the login UI when no resumable session exists.

**Rationale:** Shared-domain cookies provide seamless SSO — log in once at Engram, and all apps recognize the session. The continue-first browser flow gives first-party apps session continuity after the 15-minute access-token expiry while keeping refresh-token rotation centralized in Engram. Bearer tokens remain the right fallback for native, API, and non-browser scenarios.

### 5. PostgreSQL Database

**Decision:** Engram uses a new `engram` database on on-prem-host's existing PostgreSQL 16 instance. Dashboard migrates from SQLite to PostgreSQL (new `dashboard` database on the same instance), dropping its own User table in favor of Engram's.

**Rationale:** on-prem-host already runs PostgreSQL 16 for Synapse, Firecrawl, and OpenClaw. Adding databases is zero incremental infrastructure. PostgreSQL provides proper concurrent access and relational constraints needed for refresh token rotation and OAuth account linking. Dashboard's SQLite limitations (single-writer, no CASCADE) are resolved.

### 6. Schema

**Decision:** Engram owns all identity-related models:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String         @id @default(cuid())
  username      String         @unique
  email         String         @unique
  passwordHash  String?
  emailVerified Boolean        @default(false)
  avatarUrl     String?
  role          String         @default("USER") // ADMIN or USER
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
  refreshTokens RefreshToken[]
  oauthAccounts OAuthAccount[]
  magicLinks    MagicLink[]
  orgMembers    OrgMember[]
}

model WaitlistRequest {
  id          String   @id @default(cuid())
  email       String   @unique
  displayName String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model Organization {
  id         String      @id @default(cuid())
  name       String      @unique
  slug       String      @unique
  createdAt  DateTime    @default(now())
  updatedAt  DateTime    @updatedAt
  members    OrgMember[]
}

model OrgMember {
  id        String       @id @default(cuid())
  user      User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId    String
  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  orgId     String
  role      String       @default("MEMBER") // ADMIN, MEMBER
  createdAt DateTime     @default(now())

  @@unique([userId, orgId])
}

model RefreshToken {
  id        String   @id @default(cuid())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId    String
  tokenHash String   @unique // SHA-256 hash of the refresh token
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([userId])
}

model OAuthAccount {
  id                String   @id @default(cuid())
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId            String
  provider          String   // "google" or "github"
  providerAccountId String
  createdAt         DateTime @default(now())

  @@unique([provider, providerAccountId])
  @@index([userId])
}

model MagicLink {
  id        String    @id @default(cuid())
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId    String
  token     String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}
```

Dashboard drops its `User` model and references Engram user IDs as foreign keys (stored as plain strings, no cross-database FK). Synapse migrates its User, OAuthAccount, MagicLink, and RefreshToken models to Engram.

### 7. API Routes

**Decision:** Engram exposes the following routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/register` | POST | Disabled; returns waitlist guidance instead of creating accounts |
| `/api/waitlist` | POST | Record a waitlist request for a prospective user |
| `/api/auth/login` | POST | Login with email + password, returns JWT pair |
| `/api/auth/continue` | GET | Resume browser session via access/refresh cookie or fall back to login |
| `/api/auth/refresh` | POST | Exchange refresh token for new token pair (rotation) |
| `/api/auth/logout` | POST | Invalidate refresh token, clear cookies |
| `/api/auth/magic-link` | POST | Request a magic link email |
| `/api/auth/magic-link/verify` | GET | Verify magic link token, returns JWT pair |
| `/api/auth/oauth/[provider]` | GET | Redirect to Google or GitHub OAuth |
| `/api/auth/oauth/[provider]/callback` | GET | Handle OAuth callback, issue JWT pair |
| `/api/auth/change-password` | POST | Change password (authenticated) |
| `/api/users/me` | GET | Get current user profile |
| `/api/users/me` | PATCH | Update current user profile |
| `/api/orgs` | GET | List user's organizations |
| `/api/orgs` | POST | Create organization |
| `/api/orgs/[orgId]` | PATCH | Update organization |

**Rationale:** Full auth lifecycle plus basic user/org management. Consuming apps call `/api/users/me` to hydrate user info when they only have a JWT with a user ID.

### 8. Pages (Login UI)

**Decision:** Engram hosts the login and waitlist UI. Browser consumers send users to Engram's continue endpoint with a `redirect_uri` parameter. Continue first tries to resume the existing session; if that is not possible, it falls back to the login UI and then redirects back to the originating app after successful auth.

| Page | Purpose |
|------|---------|
| `/login` | Email+password login, OAuth buttons, magic link option |
| `/register` | Waitlist request form for users who need access |
| `/account` | User profile and account settings |

**Rationale:** Centralizing the login UI means one consistent experience. Users always see the same login page regardless of which app they're accessing. This also means OAuth redirect URIs only need to point to Engram, not each individual app.

### 9. How Consuming Apps Integrate

**Decision:** Each consuming app (Dashboard, Synapse, Thoughts, Axon) integrates with Engram by:

1. **Validating JWTs** — using a shared `ENGRAM_JWT_SECRET` to verify access tokens locally (no network call). Every app's `authenticateRequest()` checks for the JWT in cookies or Authorization header.

2. **Redirecting to Engram continue flow** — when no valid browser access token is found, redirect to `ENGRAM_URL/api/auth/continue?redirect_uri=<app_url>`. Continue either resumes the session or redirects to login.

3. **Fetching user info** — call `ENGRAM_URL/api/users/me` with the JWT to get user profile data (username, email, avatar, role). Cache locally to avoid repeated calls.

4. **Keeping internal API key auth** — service-to-service calls (CORTEX conductor → Dashboard) continue using `X-Internal-API-Key`. Engram auth is for human users.

**Rationale:** JWT validation is stateless and adds zero latency. The continue-first flow gives browser users session continuity after access-token expiry without forcing each consumer app to implement its own refresh choreography. Internal API keys coexist without conflict.

### 10. Password Storage

**Decision:** bcrypt with cost factor 12, using the `bcryptjs` library. Same as Synapse's current implementation.

**Rationale:** Consistency, battle-tested, ~250ms hash time.

## Considered Options

### A. Replicate Synapse Auth into Dashboard

Build the same custom JWT auth independently in Dashboard with its own User table.

**Rejected:** Creates two independent user stores that would need to be merged later. Duplicates OAuth configs, auth logic, and security maintenance. Every new app would need its own auth implementation. The effort is comparable to building Engram, but the outcome is worse.

### B. Keep NextAuth and Add OAuth

Add Google and GitHub providers to Dashboard's existing NextAuth setup.

**Rejected:** Solves only Dashboard's immediate need. Still no shared identity, still username-based, still no refresh token rotation. Synapse would remain on a completely different auth system.

### C. Use an Off-the-Shelf Auth Service (Keycloak, Authelia)

Deploy Keycloak or Authelia as the identity provider.

**Rejected:** Heavy operational overhead for 2-3 users. Keycloak alone requires 512MB+ RAM and a Java runtime. These tools are designed for enterprises with hundreds of users and complex federation requirements. CORTEX's needs are well within what a lightweight custom service can handle.

### D. Make Synapse the Auth Provider

Instead of a new service, extend Synapse to serve as the identity provider for all apps.

**Rejected:** Synapse's purpose is chat. Bundling identity management into it violates single responsibility and creates a deployment coupling — you can't update Synapse without risking auth for all other apps. A dedicated service with a clear boundary is cleaner.

## Deployment

| Property | Value |
|----------|-------|
| Container name | `engram` |
| Port | 3104 |
| Docker network | `cortex-apps` |
| Canonical on-prem auth URL | `https://login.rapidagent.dev:8443` |
| Canonical aws-dev auth URL | `https://login.dev.ctxhost.com` |
| Legacy on-prem alias | `engram.rapidagent.dev` |
| Database | `postgresql://engram:***@host.docker.internal:5432/engram` |
| Health check | `http://localhost:3104/api/health` |

### 2026-04-17 — Session continuity and redirect hardening

- Added `/api/auth/continue` as the preferred browser handoff for first-party apps.
- Documented that browser consumers should redirect to continue before login.
- Clarified that cookie scope is environment-driven via `ENGRAM_COOKIE_DOMAIN`.
- Updated magic-link verification to reflect the current GET callback route.


Caddy on on-prem-host adds a reverse proxy entry for `login.rapidagent.dev:8443` -> `localhost:3104`. Legacy `engram.rapidagent.dev` references may remain during the cutover, but new manifests and environment variables use `login.rapidagent.dev:8443`.

## Migration Strategy

### Phase 0: Bootstrap Engram

1. Create the `engram` repo (Next.js 15, Prisma, PostgreSQL)
2. Extract auth code from Synapse (jwt.ts, auth.ts, password utilities, OAuth flows)
3. Implement the schema, API routes, and login UI
4. Deploy to on-prem-host as a Docker container on port 3104
5. Configure Caddy for Engram (`login.rapidagent.dev:8443` today; `engram.rapidagent.dev` was the original bootstrap host)
6. Create the initial admin user (migrate Roland's existing credentials)

### Phase 1: Dashboard Integration

1. Create `dashboard` database on PostgreSQL (migrate from SQLite)
2. Remove NextAuth, User model, and auth pages from Dashboard
3. Add JWT validation using shared secret
4. Add redirect-to-Engram login flow
5. Update `authenticateRequest()` to validate Engram JWTs
6. Replace `createdById` FK with plain string referencing Engram user ID

### Phase 2: Synapse Integration

1. Move ownership of human identity, interactive login, OAuth, and session issuance to Engram
2. Point Synapse auth validation at Engram's JWT secret
3. Remove Synapse-owned human login/register UI and redirect browser users through Engram continue flow
4. Migrate/link existing Synapse human users into Engram while preserving local authorization context
5. Keep existing Synapse agent auth as a migration bridge while ADR-008 defines the future Engram service-principal model for non-human identities

### Phase 3: Thoughts & Axon Integration

1. Add JWT validation to Thoughts and Axon
2. Replace API key auth for human users with Engram JWT validation
3. Keep API key auth for agent/service-to-service calls

## Environment Variables

### Engram Service

```env
DATABASE_URL="postgresql://engram:PASSWORD@host.docker.internal:5432/engram"
ENGRAM_JWT_SECRET="..."             # HS256 signing key for all CORTEX apps
ENGRAM_GOOGLE_CLIENT_ID="..."
ENGRAM_GOOGLE_CLIENT_SECRET="***"
ENGRAM_GITHUB_CLIENT_ID="..."
ENGRAM_GITHUB_CLIENT_SECRET="***"
RESEND_API_KEY="***"                # Magic links, email verification, password reset
EMAIL_FROM="Engram <noreply@ctxhost.com>"  # Sender used for auth emails
ENGRAM_URL="https://login.rapidagent.dev:8443"
ENGRAM_INTERNAL_API_KEY="***"
```

### Consuming Apps (Dashboard, Synapse, etc.)

```env
ENGRAM_JWT_SECRET="..."             # Same secret — for local JWT validation
ENGRAM_URL="https://login.rapidagent.dev:8443"  # For login redirects and user info API
```

### Removed from Dashboard

```env
# These go away:
NEXTAUTH_SECRET
NEXTAUTH_URL
```

## Consequences

### Positive

- Single user identity across all CORTEX applications (true SSO)
- One set of OAuth credentials (one Google app, one GitHub app)
- Auth logic maintained and secured in one place
- Adding auth to a new app = validate JWTs + redirect to Engram (hours, not days)
- Organizations and RBAC managed centrally
- Dashboard gets OAuth + magic links without implementing any auth logic
- Clean separation of concerns — Engram owns identity, apps own their domain

### Negative

- New service to build, deploy, and maintain
- Redirect-based login adds a hop compared to in-app login forms
- Single point of failure — if Engram is down, no new logins (existing JWTs still work for 15 min)
- Cross-app cookie strategy requires shared domain (subdomains of rapidagent.dev)

### Risks

- **Engram downtime** — mitigated by short access token TTL: existing sessions survive 15 min without Engram. Engram itself is a simple stateless Next.js app with high uptime.
- **Cookie scope** — mitigated by environment-driven cookie scoping (`ENGRAM_COOKIE_DOMAIN` in production, host-only cookies when unset) plus Bearer header fallback for local dev and non-browser clients.
- **Migration complexity** — mitigated by phased approach: Engram launches standalone, apps migrate one at a time, old auth coexists during transition.
- **Synapse code extraction** — mitigated by the fact that Synapse's auth is already well-structured in isolated modules (jwt.ts, auth.ts, oauth routes).

## Amendment Notes

### 2026-04-28 — Native clients concretized by ADR-002

ADR-002 is now accepted and implements the reusable native-client auth substrate:
registered first-party native clients, exact redirect URI allow-lists,
Authorization Code + PKCE, and native refresh/logout transports. This ADR
remains the identity-system foundation; ADR-002 owns native-client protocol
details.

### 2026-04-25 — Non-human principals deferred to ADR-008

This ADR remains authoritative for human identity, interactive authentication, browser SSO, native bearer access, and refresh-token rotation. ADR-008 adds the target model for non-human agent/service principals. Agents and service accounts are not ordinary human users and should not receive human browser sessions or human refresh tokens.
