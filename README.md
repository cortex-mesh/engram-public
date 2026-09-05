# Engram

Centralized identity & authentication service for the [CORTEX mesh](https://github.com/cortex-mesh).

Engram owns all user identity, authentication, and organization management. Other CORTEX applications (Nexus, Plexus, Synapse, Thoughts, Pulse, Axon, Gyrus) validate JWTs locally or call Engram admission APIs while delegating login, waitlist intake, and account management to Engram.

See [ADR-001](docs/adr/ADR-001-engram-identity-service.md) for the founding design decision.

---

## Features

- **Email + Password** — bcrypt (cost 12), email normalization, anti-enumeration responses
- **OAuth 2.0** — Google and GitHub providers for existing approved accounts, with account linking by email
- **Magic Links** — passwordless email login via Resend (15-minute expiry, rate limited)
- **Waitlist Intake** — self-service signup is disabled; `/register` collects waitlist requests instead of creating accounts
- **JWT with Rotation** — short-lived access tokens (15 min) + long-lived refresh tokens (30 days) with reuse detection
- **Cross-App SSO** — shared-domain cookies when `ENGRAM_COOKIE_DOMAIN` is set (for example `.rapidagent.dev`), with host-only cookies as the fallback
- **Organization Management** — multi-tenant org model with role-based membership (ADMIN/MEMBER)
- **Internal API Key Auth** — service-to-service calls via `X-Internal-API-Key` header
- **Anti-Enumeration** — waitlist and magic link endpoints return identical responses whether an account exists or not

## Tech Stack

| Tool       | Version | Notes                                        |
| ---------- | ------- | -------------------------------------------- |
| Next.js    | 16      | App Router, standalone output for Docker     |
| TypeScript | 5       | Strict mode                                  |
| React      | 19      | UI                                           |
| Prisma     | 7       | ORM with PostgreSQL adapter (`@prisma/adapter-pg`) |
| PostgreSQL | 16      | Database (on on-prem-host at localhost)         |
| jose       | 6       | JWT signing/verification (HS256)             |
| bcryptjs   | 3       | Password hashing (cost factor 12)            |
| nanoid     | 5       | Secure token generation for magic links      |
| Resend     | 4       | Transactional email (magic links)            |
| Tailwind   | 4       | Styling                                      |
| shadcn/ui  |         | Component library (Radix primitives)         |

## Quick Start

```bash
# Clone the repo
git clone git@github.com:cortex-mesh/engram.git
cd engram

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your DATABASE_URL, ENGRAM_JWT_SECRET, OAuth creds

# Generate Prisma client
npm run prisma:generate

# Create database (PostgreSQL must be running)
createdb -U postgres engram

# Apply database migrations
npx prisma migrate deploy

# Start dev server (port 3104)
npm run dev
```

## Dev Commands

```bash
npm run dev              # Dev server on port 3104
npm run build            # Production build
npm run start            # Production server on port 3104
npm run typecheck        # TypeScript type checking (tsc --noEmit)
npm run lint             # ESLint
npm run prisma:generate  # Regenerate Prisma client after schema changes
npx prisma migrate dev   # Create + apply migration (dev only)
npx prisma migrate deploy # Apply pending migrations (production)
npx prisma studio        # Visual database browser
```

## Environment Variables

### Engram Service

| Variable                     | Required | Description                                        |
| ---------------------------- | -------- | -------------------------------------------------- |
| `DATABASE_URL`               | Yes      | PostgreSQL connection string                       |
| `ENGRAM_JWT_SECRET`          | Yes      | HS256 signing key — shared with all CORTEX apps    |
| `ENGRAM_URL`                 | Yes      | Public auth URL (e.g., `https://login.rapidagent.dev:8443` on-prem or `https://login.dev.ctxhost.com` in aws-dev) |
| `ENGRAM_GOOGLE_CLIENT_ID`    | No       | Google OAuth 2.0 client ID                         |
| `ENGRAM_GOOGLE_CLIENT_SECRET`| No       | Google OAuth 2.0 client secret                     |
| `ENGRAM_GITHUB_CLIENT_ID`    | No       | GitHub OAuth client ID                             |
| `ENGRAM_GITHUB_CLIENT_SECRET`| No       | GitHub OAuth client secret                         |
| `RESEND_API_KEY`             | No       | Resend API key for magic links and email           |
| `EMAIL_FROM`                 | No       | Sender address for auth email, defaults to `Engram <noreply@ctxhost.com>` |
| `ENGRAM_INTERNAL_API_KEY`    | No       | Service-to-service API key for internal calls      |
| `ENGRAM_ENABLE_NATIVE_AUTH_FIXTURE` | No | Set to `1` only in dev/test targets that need the superadmin native auth-code fixture |

### Consuming Apps (Dashboard, Synapse, etc.)

| Variable            | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `ENGRAM_JWT_SECRET`  | Same secret — for local JWT validation (zero network calls) |
| `ENGRAM_URL`         | For continue/login redirects and `/api/users/me` calls |

### Hosted App Catalog URLs

In production-mode deployments, Engram hides catalog apps whose public URL is
unset. These variables are part of the hosted app access contract because they
feed redirect allowlists and `/api/me/app-switcher`.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_DASHBOARD_URL` | Nexus/operator dashboard catalog URL |
| `NEXT_PUBLIC_SYNAPSE_URL` | Synapse hosted app URL |
| `NEXT_PUBLIC_THOUGHTS_URL` | Thoughts hosted app URL |
| `NEXT_PUBLIC_AXON_URL` | Axon hosted app URL |
| `NEXT_PUBLIC_PULSE_URL` | Pulse hosted app URL |
| `NEXT_PUBLIC_GYRUS_URL` | Gyrus hosted app URL, e.g. `https://cortex.dev.ctxhost.com/gyrus` in aws-dev |

If a user can authenticate but gets redirected out of a hosted app after the
app briefly loads, check `docs/runbooks/hosted-app-login-and-switcher.md`.

## API Routes

### Authentication

| Route                                    | Method | Purpose                                          |
| ---------------------------------------- | ------ | ------------------------------------------------ |
| `/api/auth/register`                     | POST   | Disabled; returns waitlist-required guidance     |
| `/api/waitlist`                          | POST   | Submit a waitlist request                        |
| `/api/auth/login`                        | POST   | Login with email + password → JWT pair           |
| `/api/auth/continue`                     | GET    | Resume session via access/refresh cookie or fall back to login |
| `/authorize`                             | GET    | Start native Authorization Code + PKCE for a registered first-party client |
| `/api/auth/token`                        | POST   | Exchange native authorization code + PKCE verifier for JWT pair and approved native tenant list |
| `/api/auth/refresh`                      | POST   | Rotate refresh token → new JWT pair              |
| `/api/auth/logout`                       | POST   | Invalidate refresh token, clear cookies          |
| `/api/auth/change-password`              | POST   | Change password (authenticated)                  |
| `/api/auth/magic-link`                   | POST   | Request a magic link email                       |
| `/api/auth/magic-link/verify`            | GET    | Verify magic link token → JWT pair               |
| `/api/auth/oauth/google`                | GET    | Redirect to Google OAuth consent                 |
| `/api/auth/oauth/google/callback`       | GET    | Handle Google OAuth callback → JWT pair          |
| `/api/auth/oauth/github`               | GET    | Redirect to GitHub OAuth consent                 |
| `/api/auth/oauth/github/callback`       | GET    | Handle GitHub OAuth callback → JWT pair          |
| `/api/admin/native-auth-codes`          | POST   | Dev/test-only superadmin fixture for native auth-code smoke |

### Users & Profile

| Route             | Method    | Purpose                        |
| ----------------- | --------- | ------------------------------ |
| `/api/users/me`   | GET       | Get current user profile       |
| `/api/users/me`   | PATCH     | Update current user profile    |

### System

| Route           | Method | Purpose        |
| --------------- | ------ | -------------- |
| `/api/health`   | GET    | Health check   |

### Pages

| Page        | Purpose                                                  |
| ----------- | -------------------------------------------------------- |
| `/login`    | Email+password login, OAuth buttons, magic link option   |
| `/register` | Waitlist request form for users who need access          |

## Architecture Overview

```
                       ┌──────────────────────────────────────┐
                       │          Browser / Client            │
                       └──────────┬───────────────────────────┘
                                  │
                    Cookie (engram-access / engram-refresh)
                    or Authorization: Bearer <token>
                                  │
                       ┌──────────▼──────────────┐
                       │     Engram (:3104)       │
                       │ login.rapidagent.dev:8443 │
                       ├──────────────────────────┤
                       │  Next.js App Router      │
                       │  ├── /login, /register   │  ← Login + waitlist UI
                       │  ├── /api/auth/*         │  ← Auth API
                       │  ├── /api/users/me       │  ← Profile API
                       │  └── /api/health         │  ← Health
                       ├──────────────────────────┤
                       │  Libraries               │
                       │  ├── jwt.ts   (jose)     │  ← Sign/verify HS256
                       │  ├── auth.ts             │  ← Request auth
                       │  ├── password.ts (bcrypt) │  ← Hash/verify
                       │  ├── crypto.ts (SHA-256) │  ← Token hashing
                       │  └── oauth/ (google/gh)  │  ← OAuth flows
                       ├──────────────────────────┤
                       │  Prisma ORM              │
                       │  ├── User                │
                       │  ├── WaitlistRequest     │
                       │  ├── RefreshToken         │
                       │  ├── OAuthAccount         │
                       │  ├── MagicLink            │
                       │  ├── Organization         │
                       │  └── OrgMember            │
                       └──────────┬───────────────┘
                                  │
                       ┌──────────▼──────────────┐
                       │  PostgreSQL 16 (on-prem-host)   │
                       │  Database: engram        │
                       └──────────────────────────┘

   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │  Dashboard   │  │   Synapse   │  │  Thoughts   │  │    Axon     │
   │   :3100      │  │   :3101     │  │   :3102     │  │   :3103     │
   └──────┬───────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                 │                 │                 │
          └─────────────────┴─────────────────┴─────────────────┘
                    Validate JWTs locally using shared
                    ENGRAM_JWT_SECRET (no network call)
                    Redirect to Engram /api/auth/continue for browser auth
```

### How Consuming Apps Integrate

1. **JWT Validation** — each app uses the shared `ENGRAM_JWT_SECRET` to verify access tokens locally (zero latency, no network call)
2. **Continue Redirect** — when no valid access token is found, redirect browser users to `ENGRAM_URL/api/auth/continue?redirect_uri=<app_url>`. Engram will continue immediately if the access cookie is still valid, rotate via refresh cookie if possible, or fall back to `/login`.
3. **User Info** — call `ENGRAM_URL/api/users/me` with the JWT to get user profile data
4. **Internal API Key** — service-to-service calls use `X-Internal-API-Key` header (agents, conductor)

### Native Client Integration

Native apps use Authorization Code + PKCE through Engram instead of collecting credentials directly. Each app is registered in the `NativeAuthClient` / `NativeAuthRedirectUri` tables with an exact `client_id` and callback URI list. Adding a future first-party native app should be a registration/data operation, not a new auth implementation.

Until native-client management is exposed in the superadmin console, register clients with Prisma/Studio or a migration by creating one `NativeAuthClient` row and one or more exact `NativeAuthRedirectUri` rows. The redirect URI used in `/authorize` and `/api/auth/token` must match a registered row exactly.

1. Generate a PKCE verifier and S256 challenge.
2. Open `ENGRAM_URL/authorize?response_type=code&client_id=<client_id>&redirect_uri=<callback>&code_challenge=<challenge>&code_challenge_method=S256&state=<state>&app=<app-key>`.
3. Receive the authorization code at the registered callback URI.
4. POST `grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`, and `code_verifier` to `/api/auth/token`.
5. For identity-first apps such as Synapse Native, present the returned `tenants[]` list and let the user choose one of the Engram-approved tenant hosts.
6. Store the returned refresh token in the platform secure store and send the access token as `Authorization: Bearer <token>` to consuming apps.
7. Rotate with `/api/auth/refresh` using a body refresh token; revoke with `/api/auth/logout`.

Native `/authorize` code issuance is gated by native client/redirect registration, an authenticated approved Engram user, S256 PKCE, and an explicit native client/app binding. Tenant-scoped flows may still pass `tenant=<org-slug>&app=synapse`; those are additionally gated by tenant org membership, org app entitlement, and per-user app deny overrides before issuing a code. Tenantless Synapse Native uses `app=synapse`; `/api/auth/token` returns only the tenant hosts that pass those same org/app checks for the authenticated user.

After an explicit native sign-out, clients may append `prompt=login` to the next `/authorize` request. Engram validates the native client first, then routes through `/api/auth/continue?prompt=login` so existing browser cookies do not silently issue a new native authorization code. The post-login redirect removes `prompt=login` before returning to `/authorize` to avoid an auth loop.

#### Cite the Move client identity

`axon-web` remains the internal client id and stays bound to `app=axon`; its
public display and email identity is **Cite the Move**. That is presentation
metadata only: the client remains enabled and waitlist-gated, and its existing
development, local, and on-prem callback registrations remain exact and
unchanged. Waitlist confirmation and approval emails use the Cite the Move name
while sending from Engram's configured verified sender and retaining the
"secured by Engram" attribution.

For the separately human-gated production auth preparation, only
`auth.citethemove.com` may bind the bare auth surfaces to `axon-web`; it must
be included exactly in `ENGRAM_ALLOWED_HOSTS` alongside the canonical Engram
host. That same allowlist supplies the public-origin, CORS, and cookie-write
CSRF trust boundary, while cookies remain host-only. The only permitted Cite
production native callback is `https://app.citethemove.com/auth/callback`.

`npm run reconcile:cite-production-client` is deliberately dry-run by default
and prints only redirect-URI drift. It refuses to create `axon-web`; after a
human production gate, `--apply` additionally requires
`ENGRAM_RECONCILE_CONFIRM=citethemove-production-client` and removes every
other callback for that client. It is never run by CI or application startup.

The production callback, branded auth host, DNS, provider callback, sender
domain, secret, certificate, and production deployment remain a human gate.
Do not infer or add any of them from this repository change.

### Redirect Safety

- `redirect_uri` values are validated before redirecting.
- Engram rejects protocol-relative redirects such as `//evil.com`.
- Relative redirects are normalized safely to absolute URLs when used by first-party auth callbacks.
- Browser SSO should only target trusted first-party app origins.

### Authentication Priority Order

The `authenticateRequest()` function checks credentials in this order:

1. `X-Internal-API-Key` header (trusted internal services → userId: "internal", role: ADMIN)
2. `engram-access` cookie (JWT access token)
3. `Authorization: Bearer <token>` header

## Repo Structure

```
engram/
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── (auth)/                 # Auth page group (login, register)
│   │   └── api/
│   │       ├── health/             # Health check
│   │       ├── auth/               # All auth endpoints
│   │       │   ├── register/       # Disabled self-service signup
│   │       │   ├── login/
│   │       │   ├── refresh/
│   │       │   ├── logout/
│   │       │   ├── change-password/
│   │       │   ├── magic-link/     # + verify/
│   │       │   └── oauth/          # google/ + github/ (+ callbacks)
│   │       ├── waitlist/           # Waitlist request intake
│   │       └── users/me/           # Profile GET/PATCH
│   ├── lib/
│   │   ├── jwt.ts                  # JWT sign/verify (jose, HS256)
│   │   ├── auth.ts                 # Request authentication
│   │   ├── password.ts             # bcryptjs hash/verify
│   │   ├── crypto.ts               # SHA-256 helper
│   │   ├── prisma.ts               # Prisma client singleton
│   │   ├── db/                     # DB helper modules
│   │   │   ├── oauth-accounts.ts
│   │   │   └── magic-links.ts
│   │   └── oauth/                  # OAuth provider flows
│   │       ├── google.ts
│   │       └── github.ts
│   ├── components/ui/              # shadcn/ui components
│   └── generated/prisma/           # Generated Prisma client
├── prisma/
│   └── schema.prisma               # Database schema (7 models)
├── docs/
│   ├── adr/                        # Architecture Decision Records
│   │   └── ADR-001-engram-identity-service.md
│   └── architecture-audit.md       # Living architecture document
├── docker-compose.yml              # on-prem-host deployment
├── Dockerfile                      # Standalone Next.js container
├── docker-entrypoint.sh
├── package.json
├── tsconfig.json
└── next.config.ts
```

## Production Deployment

Runs as a Docker container (`engram`) on on-prem-host, port 3104, behind Caddy reverse proxy at `login.rapidagent.dev:8443` and `platform.rapidagent.dev:8443`. Part of the `cortex-apps` Docker network.

```bash
# Normal on-prem deploy path
cortex app deploy engram --env on-prem

# Hosted AWS dev deploy path
AWS_PROFILE=cortex AWS_REGION=us-west-2 cortex app deploy engram --env aws-dev --repo-path .

# Manual fallback from the Engram checkout
docker compose up -d --build
```

`cortex-deploy.toml` is the deployment contract for on-prem and aws-dev. It builds the image, runs `npx prisma migrate deploy` in a one-shot container before restart, renders Caddy routes, and then health-checks `/api/health`. The long-running container entrypoint does not auto-migrate on normal startup.

After `main` CI passes, `.github/workflows/deploy.yml` deploys Engram to both AWS dev and on-prem-host/on-prem and verifies the public auth/admin health endpoints. Manual dispatch from `main` can rerun either target independently.

> **Trap:** the auto-deploy is gated on the *whole* main CI run concluding `success`, so a **red main CI silently skips the deploy** — no deploy failure is reported. CI includes `npm audit --audit-level=moderate`, which can turn main red **with no code change** when a new advisory is published against an already-installed dep. When a merged change doesn't reach dev, check main's CI conclusion first; clear the advisory (bump/override the pin, as in PR #189) to re-green CI and let the next deploy run.

**aws-prod** is a separate, **human-dispatch-only** serverless path (CloudFront + Lambda, ADR-025 §11): run [`scripts/promote-prod.sh`](scripts/promote-prod.sh) — a guarded wrapper over `deploy-prod.yml`. Agents never dispatch it. Current prod consumers are Engram itself, Tradepost (`auth.ccgtradepost.com`), and Cite the Move / Axon (`auth.citethemove.com`, live since 2026-08-04 — the ADR-034 enrollment authority serves it, though the `app.citethemove.com` product surface is not yet deployed). See [`docs/runbooks/prod-promotion.md`](docs/runbooks/prod-promotion.md).

### CORTEX App Fleet on on-prem-host

| Container     | App       | Port | Stack                | Repo     |
| ------------- | --------- | ---- | -------------------- | -------- |
| **dashboard** | Plexus    | 3100 | Next.js (standalone) | plexus   |
| **synapse**   | Synapse   | 3101 | Next.js + WebSocket  | synapse  |
| **thoughts**  | Thoughts  | 3102 | Next.js + Prisma     | thoughts |
| **axon**      | Finance   | 3103 | Python + React SPA   | finance  |
| **engram**    | Identity  | 3104 | Next.js + Prisma     | engram   |
| **pulse**     | Pulse     | 3105 | Next.js + Prisma     | pulse    |

## Related

- **[ADR-001: Engram Identity Service](docs/adr/ADR-001-engram-identity-service.md)** — founding design decision, full rationale
- **[Architecture Audit](docs/architecture-audit.md)** — detailed system architecture document
- **[Synapse ADR-015](https://github.com/cortex-mesh/synapse)** — original user auth design (source of extracted auth code)
- **[Synapse ADR-014](https://github.com/cortex-mesh/synapse)** — organizations and multi-tenancy (informed org model)
- **[CORTEX Architecture Audit](https://github.com/cortex-mesh/cortex)** — overall mesh architecture
