# Engram Bootstrap — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Bootstrap the Engram identity & authentication service as a Next.js app matching the Thoughts/Synapse project structure, with auth code extracted from Synapse.

**Architecture:** Next.js 16 + React 19 + Tailwind v4 + shadcn/ui (new-york), PostgreSQL via Prisma 7, custom JWT auth (jose), deployed as Docker container on on-prem-host port 3104.

**Tech Stack:** Next.js 16.1.6, React 19.2.3, Prisma 7.4.1, jose, bcryptjs, pg, shadcn/ui, Tailwind CSS v4, lucide-react

---

### Phase 1: Project Scaffold (Tasks 1-5)

#### Task 1: Initialize Next.js project
Create the Next.js app with the same config as Thoughts.

#### Task 2: Configure Tailwind, shadcn/ui, globals.css
Match the Thoughts theme system (oklch colors, dark mode).

#### Task 3: Install shadcn/ui components
Button, Card, Input, Label, Dialog — the auth UI needs.

#### Task 4: Set up Prisma with PostgreSQL
Schema with User, RefreshToken, OAuthAccount, MagicLink, Organization, OrgMember.

#### Task 5: Docker + docker-compose
Dockerfile (standalone), docker-compose.yml for on-prem-host deployment.

### Phase 2: Auth Core (Tasks 6-9)

#### Task 6: JWT module (src/lib/jwt.ts)
Extract from Synapse — jose, HS256, access (15min) + refresh (30d) tokens.

#### Task 7: Password module (src/lib/password.ts)
bcryptjs, cost 12, hash + verify.

#### Task 8: Crypto module (src/lib/crypto.ts)
sha256 helper for refresh token hashing.

#### Task 9: Auth middleware (src/lib/auth.ts)
JWT cookie validation, Bearer header, internal API key.

### Phase 3: API Routes (Tasks 10-17)

#### Task 10: POST /api/auth/register
#### Task 11: POST /api/auth/login
#### Task 12: POST /api/auth/refresh
#### Task 13: POST /api/auth/logout
#### Task 14: POST /api/auth/magic-link + GET /api/auth/magic-link/verify
#### Task 15: GET /api/auth/oauth/google + callback
#### Task 16: GET /api/auth/oauth/github + callback
#### Task 17: GET /api/users/me + PATCH /api/users/me

### Phase 4: Login UI (Tasks 18-21)

#### Task 18: Root layout + theme system
#### Task 19: Login page (/login)
Email+password form, OAuth buttons, magic link option.

#### Task 20: Register page (/register)
#### Task 21: Account page (/account)

### Phase 5: Deploy (Tasks 22-24)

#### Task 22: Create PostgreSQL database on on-prem-host
#### Task 23: Configure Caddy for engram.rapidagent.dev
#### Task 24: Deploy container to on-prem-host
