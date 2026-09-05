# Engram Architecture Audit

**Date:** 2026-04-08
**Last Updated:** 2026-07-23
**Version:** 0.1.0
**Purpose:** Comprehensive architecture document for Engram — the centralized identity and authentication service for the CORTEX mesh. Living document updated as the system evolves.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Architecture](#2-component-architecture)
3. [Data Model](#3-data-model)
4. [Authentication Flows](#4-authentication-flows)
5. [Token Lifecycle](#5-token-lifecycle)
6. [Security Model](#6-security-model)
7. [Integration Points](#7-integration-points)
8. [Deployment Architecture](#8-deployment-architecture)
9. [Known Gaps & Future Work](#9-known-gaps--future-work)

---

## 1. System Overview

### Purpose

Engram is the centralized identity & authentication service for the CORTEX product suite. It owns all user identity, authentication, and organization management. Other CORTEX applications — Nexus, Plexus, Synapse, Thoughts, Pulse, Axon, and Gyrus — are auth consumers. They validate JWTs locally or call Engram admission APIs while delegating login, waitlist intake, and account management to Engram.

Current aws-prod consumers are Engram itself and Tradepost. Axon is expected to
join that production surface next. Gyrus and Nexus are not current prod
promotion targets; their active hosted targets remain aws-dev and on-prem-host/on-prem.

The name "Engram" refers to a hypothetical unit of memory storage in the brain — fitting for a service that remembers who you are.

### Why Engram Exists

Before Engram, each CORTEX app had its own auth (or none):

| App       | Port | Previous Auth                               |
| --------- | ---- | ------------------------------------------- |
| Dashboard | 3100 | NextAuth v5 (username+password, JWT)        |
| Synapse   | 3101 | Custom JWT (email+password, OAuth, magic links) |
| Thoughts  | 3102 | None / API key only                         |
| Axon      | 3103 | None / API key only                         |

This meant separate user stores, duplicated OAuth configs, no shared identity, and no SSO. Engram consolidates all of this into a single service. See [ADR-001](adr/ADR-001-engram-identity-service.md) for the full rationale.

### Tech Stack

| Tool       | Version | Role                                             |
| ---------- | ------- | ------------------------------------------------ |
| Next.js    | 16      | App Router, standalone output for Docker         |
| TypeScript | 5       | Language (strict mode)                           |
| React      | 19      | Login/waitlist UI                               |
| Prisma     | 7       | ORM with PostgreSQL adapter (`@prisma/adapter-pg`) |
| PostgreSQL | 16      | Database (on on-prem-host, localhost)               |
| jose       | 6       | JWT signing/verification (HS256)                 |
| bcryptjs   | 3       | Password hashing (cost factor 12)                |
| nanoid     | 5       | Secure random token generation                   |
| Resend     | 4       | Transactional email for magic links              |
| Tailwind   | 4       | Styling                                          |
| shadcn/ui  | —       | UI component library (Radix primitives)          |

### Module Count

| Category          | Files | Notes                                              |
| ----------------- | ----- | -------------------------------------------------- |
| Pages & Layout    | 6     | root layout, landing page, auth layout, login, register, account |
| API Routes        | 15    | auth (11), users/me, orgs (2), health             |
| Libraries         | 11    | jwt, auth, auth-redirect, apps, organizations, password, crypto, prisma, utils, oauth (2) |
| DB Helpers        | 2     | oauth-accounts, magic-links                        |
| UI Components     | 4     | button, card, input, label (shadcn/ui)             |
| Config            | 6     | next, tsconfig, eslint, postcss, prisma, components |
| Deployment        | 3     | Dockerfile, docker-compose.yml, docker-entrypoint.sh |
| **Total**         | **~40** |                                                  |

---

## 2. Component Architecture

### High-Level Architecture

```
                    ┌─────────────────────────────────┐
                    │        Browser / Client          │
                    └────────────┬────────────────────┘
                                 │
              Cookies (engram-access, engram-refresh)
              or Authorization: Bearer <token>
                                 │
                    ┌────────────▼────────────────────┐
                    │      Caddy (on-prem-host)               │
                    │  login.rapidagent.dev → :3104    │
                    │  platform.rapidagent.dev → :3104 │
                    └────────────┬────────────────────┘
                                 │
           ┌─────────────────────▼─────────────────────────┐
           │              Engram (:3104)                    │
           │                                               │
           │  ┌─────────────┐  ┌────────────────────────┐  │
           │  │  Pages       │  │  API Routes            │  │
           │  │  /login      │  │  /api/auth/*           │  │
           │  │  /register   │  │  /api/users/me         │  │
           │  │              │  │  /api/health            │  │
           │  └─────────────┘  └───────────┬────────────┘  │
           │                               │               │
           │  ┌────────────────────────────▼────────────┐  │
           │  │           Library Layer                  │  │
           │  │  jwt.ts ──── auth.ts ──── password.ts   │  │
           │  │  crypto.ts   oauth/google   oauth/github │  │
           │  │  db/oauth-accounts   db/magic-links      │  │
           │  └────────────────────────┬────────────────┘  │
           │                           │                   │
           │  ┌────────────────────────▼────────────────┐  │
           │  │         Prisma ORM Layer                 │  │
           │  │  User · RefreshToken · OAuthAccount      │  │
           │  │  MagicLink · Organization · OrgMember    │  │
           │  └────────────────────────┬────────────────┘  │
           └───────────────────────────┼───────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │    PostgreSQL 16 (on-prem-host)             │
                    │    Database: engram                  │
                    │    localhost:5432                │
                    └─────────────────────────────────────┘
```

### Module Inventory

#### API Routes (`src/app` and `src/app/api/`)

| Route File                                | Method | Purpose                              |
| ----------------------------------------- | ------ | ------------------------------------ |
| `authorize/route.ts`                      | GET    | Native Authorization Code + PKCE     |
| `auth/register/route.ts`                  | POST   | Self-service signup disabled            |
| `waitlist/route.ts`                       | POST   | Submit waitlist request                 |
| `auth/login/route.ts`                     | POST   | Email+password login                    |
| `auth/token/route.ts`                     | POST   | Native auth code + PKCE token exchange plus approved tenant list |
| `auth/refresh/route.ts`                   | POST   | Refresh token rotation               |
| `auth/logout/route.ts`                    | POST   | Invalidate session                   |
| `auth/change-password/route.ts`           | POST   | Change password (authenticated)      |
| `auth/magic-link/route.ts`               | POST   | Request magic link email             |
| `auth/magic-link/verify/route.ts`        | GET    | Verify magic link → JWT pair         |
| `auth/oauth/google/route.ts`             | GET    | Google OAuth redirect                |
| `auth/oauth/google/callback/route.ts`    | GET    | Google OAuth callback                |
| `auth/oauth/github/route.ts`             | GET    | GitHub OAuth redirect                |
| `auth/oauth/github/callback/route.ts`    | GET    | GitHub OAuth callback                |
| `users/me/route.ts`                       | GET/PATCH | Current user profile              |
| `orgs/route.ts`                           | GET/POST  | List and create organizations     |
| `orgs/[orgId]/route.ts`                   | PATCH     | Update organization               |
| `health/route.ts`                         | GET       | Health check                      |

#### Library Modules (`src/lib/`)

| Module                    | Purpose                                              | Key Exports                                     |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `jwt.ts`                  | JWT signing and verification using jose (HS256)      | `signAccessToken()`, `signRefreshToken()`, `verifyToken()`, `generateTokenPair()`, cookie config |
| `auth.ts`                 | Request authentication (3-tier: API key → cookie → Bearer) | `authenticateRequest()`                       |
| `native-auth.ts`          | Native client registry lookup, app binding, approved tenant resolution, auth-code issuance, and PKCE validation | `findRegisteredNativeClient()`, `listNativeAuthorizedTenants()`, `issueNativeAuthorizationCode()`, `consumeNativeAuthorizationCode()` |
| `password.ts`             | Password hashing with bcryptjs (cost 12)             | `hashPassword()`, `verifyPassword()`            |
| `crypto.ts`               | Cryptographic helpers                                | `sha256()` — for refresh token hashing          |
| `prisma.ts`               | Prisma client singleton                              | `prisma`                                        |
| `utils.ts`                | General utilities                                    | `cn()` (class name merge)                       |
| `oauth/google.ts`         | Google OAuth 2.0 flow                                | `getGoogleAuthUrl()`, `exchangeGoogleCode()`, `getGoogleUser()` |
| `oauth/github.ts`         | GitHub OAuth flow                                    | `getGitHubAuthUrl()`, `exchangeGitHubCode()`, `getGitHubUser()` |
| `db/oauth-accounts.ts`    | OAuth account DB helpers                             | `findOrCreateOAuthUser()`                       |
| `db/magic-links.ts`       | Magic link DB helpers                                | `createMagicLink()`, `verifyMagicLink()`        |

---

## 3. Data Model

Engram owns the user, organization, token, OAuth, magic-link, and native-client authorization models in a single PostgreSQL database (`engram`). The schema is managed by Prisma migrations.

### Entity Relationship Diagram

```
┌──────────────────┐       ┌──────────────────┐
│   Organization   │       │      User        │
├──────────────────┤       ├──────────────────┤
│ id         (PK)  │       │ id         (PK)  │
│ name     (unique)│       │ username (unique) │
│ slug     (unique)│       │ email    (unique) │
│ createdAt        │       │ displayName       │
│ updatedAt        │       │ passwordHash?     │
└────────┬─────────┘       │ emailVerified     │
         │                 │ avatarUrl?        │
         │                 │ role (USER/ADMIN) │
         │                 │ createdAt         │
    ┌────▼──────────┐      │ updatedAt         │
    │   OrgMember   │      └──┬──┬──┬──────────┘
    ├───────────────┤         │  │  │
    │ id      (PK)  │         │  │  │
    │ userId  (FK)──┼─────────┘  │  │
    │ orgId   (FK)  │            │  │
    │ role          │            │  │
    │ createdAt     │            │  │
    │ @@unique      │            │  │
    │  (userId,orgId)│           │  │
    └───────────────┘            │  │
                                 │  │
    ┌────────────────┐           │  │    ┌──────────────┐
    │  RefreshToken   │◄─────────┘  └───►│ OAuthAccount │
    ├────────────────┤                   ├──────────────┤
    │ id       (PK)  │                   │ id     (PK)  │
    │ userId   (FK)  │                   │ userId (FK)  │
    │ tokenHash      │                   │ provider     │
    │   (unique)     │                   │ providerAcct │
    │ expiresAt      │                   │   Id         │
    │ createdAt      │                   │ createdAt    │
    └────────────────┘                   │ @@unique     │
                                         │  (provider,  │
    ┌────────────────┐                   │   acctId)    │
    │   MagicLink    │◄──────────────    └──────────────┘
    ├────────────────┤  (User has many)
    │ id       (PK)  │
    │ userId   (FK)  │
    │ token  (unique)│
    │ expiresAt      │
    │ usedAt?        │
    │ createdAt      │
    └────────────────┘
```

### Model Details

#### User

The central identity record. All other models reference User via `userId` FK with `onDelete: Cascade`.

| Field          | Type      | Notes                                    |
| -------------- | --------- | ---------------------------------------- |
| `id`           | String    | CUID, primary key                        |
| `username`     | String    | Unique, auto-generated from email prefix |
| `email`        | String    | Unique, normalized to lowercase          |
| `displayName`  | String?   | Optional display name                    |
| `passwordHash` | String?   | Nullable — OAuth-only users have no password |
| `emailVerified`| Boolean   | Default false                            |
| `avatarUrl`    | String?   | Profile picture URL                      |
| `role`         | String    | "USER" (default) or "ADMIN"             |
| `createdAt`    | DateTime  | Auto-set on creation                     |
| `updatedAt`    | DateTime  | Auto-updated                             |

#### RefreshToken

DB-backed refresh tokens for rotation and reuse detection. Only the SHA-256 hash is stored — never the raw token.

| Field       | Type     | Notes                              |
| ----------- | -------- | ---------------------------------- |
| `id`        | String   | CUID, primary key                  |
| `userId`    | String   | FK → User (cascade delete)         |
| `tokenHash` | String   | SHA-256 hash of the raw JWT, unique |
| `expiresAt` | DateTime | 30 days from creation              |
| `createdAt` | DateTime | Auto-set                           |

#### NativeAuthClient / NativeAuthRedirectUri

Data-backed registry for first-party native apps using Authorization Code +
PKCE. New native apps should be added by registering a `clientId`, display name,
and exact allowed callback URIs; auth route code does not need app-specific
branches.

| Model | Notes |
| ----- | ----- |
| `NativeAuthClient` | One registered public client such as `broca-macos-dev`; has `displayName` and `enabled` flag |
| `NativeAuthRedirectUri` | Exact callback URI allow-list per client; custom schemes and claimed HTTPS callbacks are both supported when registered |

#### NativeAuthAuthorizationCode

Short-lived, single-use authorization codes for native PKCE exchange. Raw codes
are returned only to the browser redirect and stored server-side as SHA-256
hashes.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `codeHash` | String | SHA-256 hash of the raw authorization code |
| `clientId` | String | Registered native client |
| `userId` | String | Authenticated Engram user |
| `redirectUri` | String | Exact redirect URI used during authorize and token exchange |
| `codeChallenge` | String | S256 PKCE challenge |
| `expiresAt` | DateTime | 5-minute authorization-code lifetime |
| `consumedAt` | DateTime? | Set when successfully exchanged |

#### OAuthAccount

Links external OAuth provider identities to Engram users. Supports account linking (one user can have Google + GitHub).

| Field              | Type     | Notes                                    |
| ------------------ | -------- | ---------------------------------------- |
| `id`               | String   | CUID, primary key                        |
| `userId`           | String   | FK → User (cascade delete)               |
| `provider`         | String   | "google" or "github"                     |
| `providerAccountId`| String   | Provider's unique user ID                |
| `createdAt`        | DateTime | Auto-set                                 |
| Unique constraint  |          | `@@unique([provider, providerAccountId])` |

#### MagicLink

Passwordless email login tokens. Rate-limited to one per user per 5 minutes. Expires after 15 minutes.

| Field       | Type      | Notes                            |
| ----------- | --------- | -------------------------------- |
| `id`        | String    | CUID, primary key                |
| `userId`    | String    | FK → User (cascade delete)       |
| `token`     | String    | Unique, generated via nanoid     |
| `expiresAt` | DateTime  | 15 minutes from creation         |
| `usedAt`    | DateTime? | Set when token is consumed       |
| `createdAt` | DateTime  | Auto-set                         |

#### Organization

Multi-tenant organization support. Not yet consumed by other apps but schema is in place.

| Field       | Type     | Notes                |
| ----------- | -------- | -------------------- |
| `id`        | String   | CUID, primary key    |
| `name`      | String   | Unique org name      |
| `slug`      | String   | Unique URL slug      |
| `createdAt` | DateTime | Auto-set             |
| `updatedAt` | DateTime | Auto-updated         |

#### OrgMember

Join table between User and Organization with role-based membership.

| Field       | Type     | Notes                              |
| ----------- | -------- | ---------------------------------- |
| `id`        | String   | CUID, primary key                  |
| `userId`    | String   | FK → User (cascade delete)         |
| `orgId`     | String   | FK → Organization (cascade delete) |
| `role`      | String   | "MEMBER" (default) or "ADMIN"     |
| `createdAt` | DateTime | Auto-set                           |
| Unique constraint |    | `@@unique([userId, orgId])`        |

---

## 4. Authentication Flows

### Flow 1: Email + Password Login

```
Client                         Engram                          PostgreSQL
  │                              │                                │
  ├── POST /api/auth/login ─────►│                                │
  │   { email, password }        │                                │
  │                              ├── Find user by email ─────────►│
  │                              │◄── User record ────────────────┤
  │                              │                                │
  │                              ├── bcrypt.compare(password,     │
  │                              │   user.passwordHash)           │
  │                              │                                │
  │                              ├── generateTokenPair()          │
  │                              │   (access 15min, refresh 30d)  │
  │                              │                                │
  │                              ├── Store SHA-256(refresh) ─────►│
  │                              │                                │
  │◄── 200 + Set-Cookie ────────┤                                │
  │   engram-access (httpOnly)   │                                │
  │   engram-refresh (httpOnly)  │                                │
  │   body: { user, accessToken }│                                │
```

**Details:**
- Email is normalized to lowercase and trimmed
- Generic "Invalid credentials" error for both missing user and wrong password (anti-enumeration)
- Users without `passwordHash` (OAuth-only) cannot login with password

### Flow 2: Waitlist Intake

```
Client                         Engram                          PostgreSQL
  │                              │                                │
  ├── POST /api/waitlist ───────►│                                │
  │   { email, displayName }     │                                │
  │                              ├── Validate email/name          │
  │                              │                                │
  │                              ├── Check if approved user ─────►│
  │                              │◄── if yes: generic 202         │
  │                              │                                │
  │                              ├── Upsert waitlist row ────────►│
  │                              │   by unique email              │
  │                              │                                │
  │◄── 202 { ok: true } ─────────┤                                │
```

**Admission policy:** Self-service registration is disabled. `/register` is a waitlist form, and the API returns the same 202 response whether the email is new, already waitlisted, or already approved.

### Flow 3: OAuth (Google / GitHub)

```
Client                    Engram                 OAuth Provider        PostgreSQL
  │                         │                         │                    │
  ├── GET /api/auth/oauth/  │                         │                    │
  │   google ──────────────►│                         │                    │
  │                         ├── Build auth URL         │                    │
  │◄── 302 Redirect ───────┤  (client_id, scope,     │                    │
  │                         │   redirect_uri, state)  │                    │
  │                         │                         │                    │
  ├── User consents ────────────────────────────────►│                    │
  │                         │                         │                    │
  │◄── 302 callback ───────────────────────────────── ┤                    │
  │   ?code=xxx&state=yyy   │                         │                    │
  │                         │                         │                    │
  ├── GET /api/auth/oauth/  │                         │                    │
  │   google/callback ─────►│                         │                    │
  │                         ├── Exchange code ────────►│                    │
  │                         │◄── access_token ────────┤                    │
  │                         ├── Get user info ────────►│                    │
  │                         │◄── { id, email, name } ─┤                    │
  │                         │                         │                    │
  │                         ├── Find existing user ───────────────────────►│
  │                         │   or redirect to waitlist  │                    │
  │                         ├── generateTokenPair()   │                    │
  │                         ├── Store refresh hash ───────────────────────►│
  │                         │                         │                    │
  │◄── 302 Redirect ───────┤                         │                    │
  │   to app + Set-Cookie   │                         │                    │
```

**Account linking:** If a user with the same email already exists, the OAuth account is linked to the existing user rather than creating a duplicate. If no approved user exists, Engram redirects the browser to the waitlist page instead of auto-provisioning a new account.

### Flow 4: Magic Link (Passwordless)

```
Client                    Engram                    Resend           PostgreSQL
  │                         │                         │                  │
  ├── POST /api/auth/       │                         │                  │
  │   magic-link ──────────►│                         │                  │
  │   { email }             │                         │                  │
  │                         ├── Find user ────────────────────────────── ►│
  │                         │   (if no user: still    │                  │
  │                         │    return generic OK)   │                  │
  │                         │                         │                  │
  │                         ├── Rate limit check ─────────────────────── ►│
  │                         │   (1 link per 5 min)    │                  │
  │                         │                         │                  │
  │                         ├── Create magic link ────────────────────── ►│
  │                         │   (nanoid, 15 min TTL)  │                  │
  │                         │                         │                  │
  │                         ├── Send email ──────────►│                  │
  │                         │                         │                  │
  │◄── 200 { ok: true } ───┤                         │                  │
  │   "If an account exists │                         │                  │
  │    with this email..."  │                         │                  │
  │                         │                         │                  │
  ├── (User clicks link) ──►│                         │                  │
  │   POST /api/auth/       │                         │                  │
  │   magic-link/verify     │                         │                  │
  │   { token }             │                         │                  │
  │                         ├── Look up + validate ──────────────────── ►│
  │                         │   token (not expired,   │                  │
  │                         │    not used)            │                  │
  │                         ├── Mark as used ─────────────────────────── ►│
  │                         ├── generateTokenPair()   │                  │
  │                         ├── Store refresh hash ──────────────────── ►│
  │                         │                         │                  │
  │◄── 200 + Set-Cookie ───┤                         │                  │
```

**Security:** Generic response for non-existent emails. Rate limited to 1 link per 5 minutes per user. Links expire after 15 minutes and are single-use.

### Flow 5: Native Authorization Code + PKCE

```
Native App                 Engram Browser Flow              PostgreSQL
  │                              │                              │
  ├── Open /authorize ──────────►│                              │
  │   client_id, redirect_uri,   │                              │
  │   app, S256 code_challenge   │                              │
  │                              ├── Validate registered client │
  │                              │   + exact redirect URI ─────►│
  │                              │                              │
  │                              ├── Continue/login if needed   │
  │                              │   via existing Engram UI      │
  │                              │                              │
  │                              ├── Store SHA-256(auth code),  │
  │                              │   PKCE challenge, 5-min TTL ─►│
  │◄── 302 callback?code=... ───┤                              │
  │                              │                              │
  ├── POST /api/auth/token ─────►│                              │
  │   code + verifier            │                              │
  │                              ├── Verify code unused/unexpired│
  │                              ├── Verify S256 PKCE verifier  │
  │                              ├── Mark code consumed ───────►│
  │                              ├── Generate JWT pair          │
  │                              ├── Store refresh hash ───────►│
  │                              ├── Resolve approved tenant    │
  │                              │   hosts for native app ─────►│
  │◄── { accessToken,            │                              │
  │      refreshToken, tenants } │                              │
```

Native clients store refresh tokens in the platform secure store and send
access tokens to consuming apps as `Authorization: Bearer <token>`. The same
`/api/auth/refresh` and `/api/auth/logout` endpoints support body-carried
refresh tokens for native clients while preserving cookie behavior for web.
For identity-first Synapse Native login, `/authorize` carries `app=synapse`
without a preselected tenant; `/api/auth/token` returns only tenant hosts where
the authenticated user has membership and Synapse app access.

---

## 5. Token Lifecycle

### Token Types

| Token          | TTL        | Storage (Client)            | Storage (Server)      | Algorithm |
| -------------- | ---------- | --------------------------- | --------------------- | --------- |
| Access Token   | 15 minutes | `engram-access` cookie or Bearer header | Stateless (JWT only) | HS256     |
| Refresh Token  | 30 days    | `engram-refresh` cookie or request body | SHA-256 hash in DB   | HS256     |

### Access Token Payload

```json
{
  "userId": "clx...",
  "role": "USER",
  "type": "access",
  "iss": "engram",
  "iat": 1712592000,
  "exp": 1712592900
}
```

### Refresh Token Payload

```json
{
  "userId": "clx...",
  "type": "refresh",
  "iss": "engram",
  "iat": 1712592000,
  "exp": 1715184000
}
```

### Token Rotation Flow

```
Client                         Engram                          PostgreSQL
  │                              │                                │
  ├── POST /api/auth/refresh ───►│                                │
  │   (engram-refresh cookie     │                                │
  │    or body.refreshToken)     │                                │
  │                              ├── Verify JWT signature         │
  │                              │   + expiration                 │
  │                              │                                │
  │                              ├── SHA-256(token) → lookup ────►│
  │                              │                                │
  │                              │   ┌── Token found ────────────►│
  │                              │   │   Delete old token         │
  │                              │   │   Generate new pair        │
  │                              │   │   Store new refresh hash   │
  │                              │   │                            │
  │                              │   └── Token NOT found ────────►│
  │                              │       (reuse detected!)        │
  │                              │       DELETE ALL user's         │
  │                              │       refresh tokens           │
  │                              │       → force re-login         │
  │                              │                                │
  │◄── 200 + new cookies ───────┤                                │
  │   body refresh also returns │                                │
  │   rotated refreshToken      │                                │
  │   or 401 (reuse detected)   │                                │
```

### Reuse Detection (with reuse-grace window — ADR-031)

When a refresh token is rotated, its row is stamped `consumedAt` (kept, not deleted) and a successor is created. If the consumed token is presented again:
1. The JWT signature is still valid (not expired)
2. The rotation's conditional update finds no *active* (`consumedAt = null`) row for it
3. **Within the grace window** (`consumedAt` ≤ 30 s ago, successor still recoverable): treated as a benign concurrent/retry refresh (multiple tabs / prefetch / a post-deploy cold-start burst) → the caller is returned the winning rotation's successor (decrypted from `replacement`) — the **same** token for every within-grace caller, so there is one chain and no parallel session — plus a fresh access token. No revoke; a low-severity `refresh.reuse_graced` event is logged.
4. **Outside the window** (or unknown token): possible theft → **delete ALL of the user's refresh tokens**, forcing re-login on every device, and emit `refresh.reuse_detected`.

The grace window (ADR-031) exists because a legitimate browser fires several concurrent refreshes at the 15-min access-token boundary; across server instances (maximally right after a client deploy) they each spend the single-use token, which pre-grace revoked the family and logged the user out on every deploy. Reuse outside the short window is still caught — an attacker replaying a token more than 30 s after a legitimate rotation still trips the alarm, and short-lived access tokens keep the blast radius bounded.

### Cookie Configuration

| Cookie           | httpOnly | Secure        | SameSite | Path        | Max-Age    |
| ---------------- | -------- | ------------- | -------- | ----------- | ---------- |
| `engram-access`  | Yes      | prod only     | Lax      | `/`         | 15 min     |
| `engram-refresh` | Yes      | prod only     | Lax      | `/api/auth` | 30 days    |

**Key decisions:**
- `httpOnly` prevents JavaScript access (XSS protection)
- `secure` only in production (allows HTTP in local dev)
- `sameSite: lax` allows cookies on top-level navigations but blocks CSRF from third-party sites
- Refresh cookie path is restricted to `/api/auth` — it's never sent to other endpoints

---

## 6. Security Model

### Password Security

- **Algorithm:** bcrypt via `bcryptjs`
- **Cost factor:** 12 (~250ms hash time)
- **Max length:** 72 characters (bcrypt limitation, enforced at API level)
- **Min length:** 8 characters
- **Storage:** Only the hash is stored (`passwordHash` field)
- **Nullable:** Users created via OAuth have no password hash

### JWT Security

- **Algorithm:** HS256 (HMAC-SHA256)
- **Library:** `jose` (RFC-compliant, no native dependencies)
- **Secret:** Shared `ENGRAM_JWT_SECRET` across all CORTEX apps
- **Issuer:** `"engram"` — verified on token validation
- **Short-lived access tokens:** 15-minute window limits blast radius of token theft
- **DB-backed refresh tokens:** SHA-256 hash stored; enables rotation and revocation

### Cookie Security

- **httpOnly:** Prevents XSS-based token theft
- **Secure flag:** Enabled in production (HTTPS only)
- **SameSite=Lax:** Prevents CSRF from third-party sites while allowing top-level navigation
- **Path restriction:** Refresh cookie scoped to `/api/auth` only

### Anti-Enumeration Protections

- **Waitlist:** Returns identical 202 response whether the email is new, already waitlisted, or already approved
- **Magic links:** Returns identical "if an account exists..." response regardless
- **Login:** Generic "Invalid credentials" for both missing user and wrong password

### Request Authentication Priority

`authenticateRequest()` in `auth.ts` checks three sources in order:

1. **`X-Internal-API-Key` header** — for service-to-service calls (conductor, internal tooling). Returns `{ userId: "internal", role: "ADMIN" }`. Compared with constant-time comparison against `ENGRAM_INTERNAL_API_KEY`.
2. **`engram-access` cookie** — primary browser auth method
3. **`Authorization: Bearer <token>` header** — fallback for API clients, mobile, and local development

### What's NOT Yet Implemented

- CSRF tokens (relying on SameSite=Lax cookies)
- Rate limiting on login attempts (application-level)
- Account lockout after failed attempts
- Email verification enforcement (field exists, not enforced)
- Audit logging of auth events

---

## 7. Integration Points

### How Consuming Apps Use Engram

#### 1. JWT Validation (Stateless, Zero Latency)

Every consuming app shares `ENGRAM_JWT_SECRET` and validates access tokens locally:

```typescript
// In any CORTEX app
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.ENGRAM_JWT_SECRET);
const { payload } = await jwtVerify(token, secret, { issuer: "engram" });
// payload.userId, payload.role available
```

No network call to Engram is needed for auth checks. This is the critical performance property.

#### 2. Continue/Login Redirect

When a consuming app detects no valid JWT:

```
→ Redirect to: ENGRAM_URL/api/auth/continue?redirect_uri=https://synapse.rapidagent.dev/chat
→ Continue either refreshes/continues immediately or falls back to /login
→ After auth, Engram redirects back with cookies set on the configured shared domain
→ The consuming app's next request includes the cookie automatically
```

#### 3. User Profile Hydration

Apps that need user details beyond what's in the JWT:

```
GET ENGRAM_URL/api/users/me
Authorization: Bearer <access_token>
→ { id, email, username, displayName, avatarUrl, role }
```

#### 4. Internal API Key (Service-to-Service)

For non-human callers (CORTEX conductor, internal scripts):

```
X-Internal-API-Key: <ENGRAM_INTERNAL_API_KEY>
→ Authenticates as { userId: "internal", role: "ADMIN" }
```

### Cross-App Cookie Strategy

The on-prem CORTEX suite lives on `*.rapidagent.dev:8443` hostnames:

| App       | Subdomain                     |
| --------- | ----------------------------- |
| Engram auth | login.rapidagent.dev        |
| Engram platform admin | platform.rapidagent.dev |
| Tenant shell | lab.rapidagent.dev         |
| Plexus   | plexus.rapidagent.dev         |
| Synapse  | lab.rapidagent.dev/synapse    |
| Thoughts | lab.rapidagent.dev/thoughts   |
| Pulse    | lab.rapidagent.dev/pulse      |
| Axon      | axon.rapidagent.dev           |

When `ENGRAM_COOKIE_DOMAIN=.rapidagent.dev` is configured, cookies are sent to all subdomains automatically, providing seamless SSO. For local development or Tailscale IP access (no shared domain), host-only cookies and the `Authorization: Bearer` header fallback are used.

---

## 8. Deployment Architecture

### Docker Deployment on on-prem-host

```
┌─────────────────────────────────────────────────────────┐
│                    on-prem-host (localhost)                 │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Caddy (reverse proxy)                │   │
│  │  login.rapidagent.dev     → localhost:3104        │   │
│  │  platform.rapidagent.dev  → localhost:3104        │   │
│  │  plexus.rapidagent.dev    → localhost:3100        │   │
│  │  lab.rapidagent.dev       → Nexus / product paths │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─── cortex-apps Docker Network ────────────────────┐  │
│  │                                                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │  │
│  │  │ engram   │ │ dashboard│ │ synapse  │          │  │
│  │  │ :3104    │ │ :3100    │ │ :3101    │          │  │
│  │  └────┬─────┘ └──────────┘ └──────────┘          │  │
│  │       │                                           │  │
│  │  ┌────┴─────┐ ┌──────────┐                       │  │
│  │  │ thoughts │ │ axon     │                       │  │
│  │  │ :3102    │ │ :3103    │                       │  │
│  │  └──────────┘ └──────────┘                       │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  PostgreSQL 16 (host, not containerized)          │   │
│  │  Databases: engram, synapse, thoughts, ...        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Container Configuration

| Property       | Value                                               |
| -------------- | --------------------------------------------------- |
| Container name | `engram`                                            |
| Port           | 3104                                                |
| Docker network | `cortex-apps` (external)                            |
| Domains        | `login.rapidagent.dev:8443`, `platform.rapidagent.dev:8443` |
| Database       | `postgresql://engram:***@host.docker.internal:5432/engram` |
| Health check   | `http://localhost:3104/api/health`                   |
| Restart policy | `unless-stopped`                                    |
| Entrypoint     | Executes supplied one-shot commands, otherwise `node server.js` |

### Docker Compose

The `docker-compose.yml` connects to the host PostgreSQL via `host.docker.internal:host-gateway` extra host mapping. Environment variables are injected from the `.env` file. The container joins the external `cortex-apps` network shared by all CORTEX applications.

### Build Pipeline

```bash
# Development
npm run dev                    # Next.js dev server on :3104

# Production build
npm run build                  # Creates .next/standalone/
docker compose up -d --build   # Build image + start container
```

The Dockerfile produces a standalone Next.js container. Prisma migrations are not applied by the long-running server entrypoint. Instead, Engram's `cortex-deploy.toml` declares an `in-image` pre-deploy hook that runs `npx prisma migrate deploy` in a one-shot container before the new app container starts. Hosted and on-prem deploys should ship a full reviewed `main` commit; routine migrations must be additive, and destructive migrations require a separate reviewed rollout and backup plan.

---

## 9. Known Gaps & Future Work

### Security Gaps (Priority)

| Gap                          | Risk   | Notes                                                    |
| ---------------------------- | ------ | -------------------------------------------------------- |
| No login rate limiting       | Medium | Brute-force attacks possible on `/api/auth/login`        |
| No account lockout           | Medium | No limit on failed login attempts                        |
| No CSRF tokens               | Low    | SameSite=Lax provides adequate protection for most flows |
| No audit logging             | Low    | Auth events not recorded for security analysis           |
| Email verification not enforced | Low | `emailVerified` field exists but login doesn't require it |

### Feature Gaps

| Gap                              | Status   | Notes                                                |
| -------------------------------- | -------- | ---------------------------------------------------- |
| Password reset flow              | Planned  | `/api/auth/forgot-password` + `/api/auth/reset-password` defined in ADR-001 but not yet implemented |
| Email verification flow          | Planned  | `/api/auth/verify-email` defined in ADR-001 but not implemented |
| Organization API routes          | Done     | `/api/orgs` and `/api/orgs/[orgId]` are implemented |
| Account settings page            | Done     | `/account` page is implemented                       |
| Setup wizard                     | Planned  | `/setup` page for first-time admin creation          |
| Dashboard integration            | Done     | Dashboard now uses Engram consumer auth              |
| Synapse integration              | Done     | Synapse now delegates human auth to Engram           |
| Thoughts/Axon integration        | Phase 3  | Need JWT validation added                            |

### Technical Debt

| Item                                | Notes                                              |
| ----------------------------------- | -------------------------------------------------- |
| No test suite                       | No unit or integration tests yet                   |
| No CI/CD pipeline                   | No GitHub Actions workflow                         |
| No refresh token cleanup            | Expired tokens accumulate in DB (need cron/cleanup) |
| No magic link cleanup               | Used/expired magic links accumulate                |
| OAuth state parameter not validated | State should be verified on callback               |
| No health check depth               | `/api/health` should check DB connectivity         |

### Future Enhancements (From ADR-001)

- **RBAC expansion** — finer-grained permissions beyond USER/ADMIN
- **Session management UI** — view and revoke active sessions
- **Multi-factor authentication** — TOTP or WebAuthn
- **API key management** — user-scoped API keys for automation
- **Redirect target allowlisting / app registration** — make trusted first-party redirect destinations explicitly configurable

---

*This is a living document. Update it when architecture changes significantly.*
*Last reviewed: 2026-04-17*
