# Architecture Decision Records

ADRs document significant architectural decisions for Engram.

## Index

| ADR | Title | Status | Date | Origin |
| --- | ----- | ------ | ---- | ------ |
| [ADR-001](ADR-001-engram-identity-service.md) | Engram — Centralized Identity & Authentication Service | Accepted | 2026-04-08 | Centralized auth, orgs, shared JWT validation |
| [ADR-002](ADR-002-native-client-authentication.md) | Native Client Authentication | Accepted | 2026-04-10 | PKCE, native token flow, first-party client registration |
| [ADR-003](ADR-003-tenant-workspace-domains-and-product-routing.md) | Tenant Workspace Domains and Product Routing | Proposed | 2026-04-20 | login.ctxhost.com, org workspace root, product paths, provider-neutral hosting |
| [ADR-004](ADR-004-initial-aws-infrastructure-with-cdk.md) | Initial AWS Infrastructure with CDK | Proposed | 2026-04-20 | CDK, EC2 app tier, RDS PostgreSQL Single-AZ, local CORTEX connectivity |
| [ADR-005](ADR-005-suite-roles-org-roles-and-app-entitlements.md) | Platform Superadmin, Org Ownership, App Entitlements, and Feature Entitlements | Accepted | 2026-04-20 | `SUPERADMIN`, org `OWNER/ADMIN/MEMBER`, centrally managed app and feature rollout |
| [ADR-006](ADR-006-engram-superadmin-console.md) | Engram Hosts the Hosted-Suite Superadmin Console | Accepted | 2026-04-21 | Global clients/users/apps/features admin UX belongs in Engram |
| [ADR-007](ADR-007-nexus-tenant-shell-boundary.md) | Nexus as the Tenant Workspace Consumer | Accepted | 2026-04-22 | Engram remains identity/control plane while Nexus owns tenant-root workspace UX |
| [ADR-008](ADR-008-human-users-and-agent-service-principals.md) | Human Users and Agent Service Principals | Proposed | 2026-04-25 | Human identity remains interactive; agents/service accounts become non-human machine principals |
| [ADR-009](ADR-009-per-user-app-entitlements.md) | Per-User App Entitlements (Default-Allow with Explicit Deny) | Proposed | 2026-04-29 | Default-allow within an org-entitled app, explicit per-user deny override |
| [ADR-010](ADR-010-consumer-app-admission-pattern.md) | Consumer App Admission Pattern | Accepted | 2026-05-03 | Codifies the 6-step admission protocol product apps follow when integrating Engram |
| [ADR-011](ADR-011-per-app-db-credentials.md) | Per-app database credentials for Engram | Proposed | 2026-05-06 | Migrate Engram from shared master DB credentials to a dedicated per-app DB role |
| [ADR-012](ADR-012-suite-jwt-audience-validation.md) | Suite JWT Audience Validation | Proposed | 2026-05-20 | Add staged audience validation for hosted suite browser SSO tokens |
| [ADR-013](ADR-013-browser-sso-cookie-and-csrf-contract.md) | Browser SSO Cookie, Logout, and CSRF Contract | Proposed | 2026-05-20 | Stabilize Engram SSO cookie semantics while adding CSRF/logout hardening |
| [ADR-014](ADR-014-jwt-signing-key-distribution.md) | JWT Signing Key Distribution and Future JWKS Migration | Proposed | 2026-05-20 | Keep HS256 short term; define asymmetric JWKS as the future key distribution target |
| [ADR-015](ADR-015-invitation-only-admission-and-waitlist.md) | Invitation-Only Admission and Waitlist Intake | Proposed | 2026-05-21 | Unknown users remain waitlist-only; approved users are invited/provisioned into orgs before app access |
| [ADR-016](ADR-016-native-pkce-auth-code-issuance.md) | Native PKCE Authorization Code Issuance for Entitled Invited Users | Proposed | 2026-05-21 | Native auth codes require registered client, authenticated approved user, app binding, and PKCE; tenantless Synapse Native login returns Engram-approved tenant hosts after token exchange |
| [ADR-017](ADR-017-oauth-only-set-password-flow.md) | Verified-Email Set-Password Flow for OAuth-Only Accounts | Proposed | 2026-06-10 | OAuth-only accounts add a password via a purpose-tagged magic link (proof of email control) |
| [ADR-018](ADR-018-tradepost-native-client.md) | Tradepost Native PKCE Client | Accepted | 2026-06-11 | Register Tradepost as a native PKCE client on the ADR-002/016 admission path |
| [ADR-019](ADR-019-per-preset-entitlements-and-ally-org.md) | Per-Preset Entitlements and the `ally` Org Preset | Accepted | 2026-06-13 | Per-preset app/feature entitlements; the `ally` org preset |
| [ADR-020](ADR-020-tenant-admin-api-owner-admin-endpoints.md) | Tenant-admin API: OWNER/ADMIN member, invite, and audit-read endpoints | Accepted | 2026-06-14 | Admit org OWNER/ADMIN to manage their own org via Bearer (Nexus proxy), reusing the ADR-009 authz pattern |
| [ADR-021](ADR-021-org-provider-credentials-store.md) | Per-Org Provider Credentials Store (BYO AI Keys) | Accepted | 2026-06-14 | Store per-org BYO provider keys in AWS Secrets Manager; DB holds only refs/metadata; OWNER/ADMIN admin API; cortex resolves per `org_id` (cortex ADR-126) |
| [ADR-022](ADR-022-internal-org-owner-lookup.md) | Internal Org-Owner Lookup — `GET /api/internal/orgs/{orgId}/owner` | Accepted | 2026-06-15 | Internal-only `requireInternalService` guard (reuses `ENGRAM_INTERNAL_API_KEY`, no new secret) + a read-only owner lookup; deterministic multi-OWNER resolution, fail-closed 404; sole consumer cortex ADR-132 §D4 (Ticket-to-Fix) |
| [ADR-023](ADR-023-next-standalone-cookies-fix.md) | Fix engram-specific standalone `cookies()` regression — middleware fallback + Next.js upgrade | Accepted | 2026-06-15 | Engram-specific (not Nexus/Pulse) `cookies()`-in-server-components regression; middleware `x-engram-access` fallback + Next 16.2.6→16.2.9 + return-URL redirect + `force-dynamic` |
| [ADR-024](ADR-024-post-login-routing-most-recently-used-org.md) | Post-Login Routing to Most-Recently-Used Org's Nexus | Accepted | 2026-06-16 | `User.lastOrgId` tracked best-effort in the app-switcher; post-login routes multi-org users to their most-recently-used (else oldest) org's Nexus instead of `/account` |
| [ADR-025](ADR-025-aws-prod-serverless-deployment.md) | AWS Prod Serverless Identity Deployment | Proposed | 2026-07-13 | Identity-only Engram prod on OpenNext/Lambda/CloudFront; dedicated Postgres (direct; RDS Proxy removed 2026-08-14); RS256/JWKS; host-only cookies; app-scoped prod stacks |
| [ADR-026](ADR-026-email-hygiene-and-suppression.md) | Email Hygiene, Provider Suppression, and Sender-Reputation Protection | Proposed | 2026-07-14 | Resend signed webhooks, durable suppression, MX/A fallback validation, vendored disposable-domain blocklist, and generic constant-time waitlist handling |
| [ADR-027](ADR-027-consumer-client-admission-and-self-serve-signup.md) | Consumer-Client Admission and Self-Serve Signup via Designated-Org Auto-Join | Accepted | 2026-07-16 | Consumer clients use designated registry orgs to complete Tradepost-style admission while suite clients keep the invitation-only path |
| [ADR-028](ADR-028-per-client-auth-brand-theming.md) | Per-Client Auth Brand Theming | Accepted | 2026-07-20 | Code-keyed auth brand theme registry, `data-brand-theme` on AuthShell, scoped token overrides for Tradepost without changing default Engram |
| [ADR-029](ADR-029-warm-signal-auth-surface-redesign.md) | Warm Signal Auth Surface Redesign | Accepted | 2026-07-20 | Warm Signal visual language for default auth surfaces — scoped `.mesh-auth-shell` token remap, CSS-only ambient + entrance animation with reduced-motion contract, Synapse/Thoughts/Pulse mesh-family row gated on `!securedByEngram`, composes with ADR-028 Tradepost theming via cascade order |
| [ADR-030](ADR-030-per-member-app-access-control.md) | Per-Member App Access Control (Restricted-Access Apps) | Accepted | 2026-07-22 | Per-app `accessMode` (ALL_MEMBERS/RESTRICTED) on `OrgAppEntitlement`; `UserAppEntitlement` as allow/deny list per mode; Engram-computed `appAccess` in `/api/orgs`; apps consume one flag; restricted apps stay non-disclosing. Motivated by private gyrus in a shared org |

## Conventions

- ADRs follow the format: `ADR-NNN-short-title.md`
- Numbering starts at ADR-001
- Status values: `Proposed`, `Accepted`, `Superseded`, `Deprecated`
