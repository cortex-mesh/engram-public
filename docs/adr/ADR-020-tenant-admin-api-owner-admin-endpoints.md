# ADR-020 — Tenant-admin API: OWNER/ADMIN member, invite, and audit-read endpoints

**Status:** Accepted — 2026-06-14  
**Deciders:** Roland, worker-a  
**Repos:** engram (this ADR), nexus (ADR-003 proxy consumer)

## Context

Nexus (the tenant workspace shell) needs to display and manage the org directory, pending invites, and roles in-app. Today, all Engram endpoints that touch member/invite state are gated to **platform SUPERADMIN** — so a hosted org's OWNER or ADMIN cannot manage their own org through Nexus. The only exception is per-user app-entitlement overrides, which ADR-009 (D3) already admitted to OWNER/ADMIN.

The goal is to expand Engram's auth surface to give tenant admins the same self-service they need, without weakening Engram's ownership of identity/org data or opening cross-origin attack vectors.

## Decisions

### D1 — Admit OWNER/ADMIN to member and invite read/manage for their own org

Mirror the `authorizeUserAppEntitlementRequest` pattern (ADR-009 §D3):

1. `authenticateRequest` already resolves cookie OR Bearer JWT — no new auth mechanism needed.
2. Re-read the platform role from DB (not the JWT claim) to catch revocation within the 15-minute token window (audit §9).
3. Re-read the caller's **org membership** from DB (not the JWT) and assert `isOrgManager` (OWNER or ADMIN).
4. The `orgId` comes from the **path param**, not the JWT. Tenant isolation holds because `isOrgManager` checks membership in `orgId` specifically.

A new shared helper `authorizeOrgAdminRequest(request, { orgId, mutation })` encapsulates steps 1–4 and is reused across all affected routes.

### D2 — Bearer auth path

`authenticateRequest` already resolves `Authorization: Bearer <JWT>` (priority #3, after internal key and cookie). `hasCrossOriginCookieWrite` passes through if the request carries no cookie header. Therefore:

- Nexus backend proxy calls these endpoints with `Authorization: Bearer <engram-access-token>` and **no Cookie header**.
- The proxy must never forward the browser's Cookie header (ADR-003 §D3 constraint — CSRF).
- No new code is required in Engram to enable Bearer; what changes is the authz tier (OWNER/ADMIN instead of SUPERADMIN).

### D3 — ADMIN privilege-escalation guard

An ADMIN cannot elevate another user's role to OWNER (only OWNER or SUPERADMIN can). This prevents an ADMIN from bootstrapping a second OWNER and then locking out the original. Enforced at the route level; if `guard.auth.superadmin === false && callerRole !== "OWNER"`, then body `role === "OWNER"` is rejected with 403.

### D4 — Audit-read endpoint

`GET /api/orgs/:orgId/audit` returns paginated `AuditLog` rows filtered to `orgId`. Accessible to OWNER/ADMIN of that org (same `authorizeOrgAdminRequest` helper). Reads are not themselves audited (audit reads are noise; we only audit state-change events).

### D5 — New audit action names

Add `"org.invite.create"` and `"org.invite.revoke"` to `AuditAction` so invite events are tracked symmetrically with member events.

### D6 — GET /api/orgs/:orgId/members (new)

Today the route only has POST. Add GET: list all members with their org role, joined date, display name. Accessible to OWNER/ADMIN of that org. Returns user IDs, usernames, display names, org roles, and join dates — but **not emails** for non-SUPERADMIN callers (email is PII; Nexus doesn't need it for the directory view).

### D7 — GET /api/orgs/:orgId/invites (new)

Today the route only has POST. Add GET: list pending (not accepted, not revoked) invites. Accessible to OWNER/ADMIN.

### D8 — DELETE /api/orgs/:orgId/invites/:inviteId (new)

Revoke a pending invite. Sets `revokedAt`. Accessible to OWNER/ADMIN. Records `org.invite.revoke` audit event.

## Invariants preserved

- **Last-manager invariant**: before demoting or removing the only OWNER/ADMIN, return 400.
- **Platform superadmin immutability**: superadmin org membership cannot be created, changed, or deleted through these endpoints.
- **Tenant isolation**: all queries filter by `orgId` from the path param; a caller from org A cannot reach org B data even if they hold a valid JWT.
- **No browser→Engram admin calls**: enforced by `hasCrossOriginCookieWrite` on mutations (cookie present + cross-origin → 403). Bearer callers from Nexus backend bypass this (no cookie).
- **No internal key for member management**: internal API key is rejected (`userId === "internal" → 403`).

## Endpoint summary

| Method | Path | Authz | Notes |
| ------ | ---- | ----- | ----- |
| GET | `/api/orgs/:orgId/members` | OWNER/ADMIN or SUPERADMIN | New handler; omits email for non-SUPERADMIN |
| POST | `/api/orgs/:orgId/members` | OWNER/ADMIN or SUPERADMIN | ADMIN cannot add role=OWNER |
| PATCH | `/api/orgs/:orgId/members/:userId` | OWNER/ADMIN or SUPERADMIN | ADMIN cannot set role=OWNER |
| DELETE | `/api/orgs/:orgId/members/:userId` | OWNER/ADMIN or SUPERADMIN | Last-manager invariant |
| GET | `/api/orgs/:orgId/invites` | OWNER/ADMIN or SUPERADMIN | New handler; pending only |
| POST | `/api/orgs/:orgId/invites` | OWNER/ADMIN or SUPERADMIN | ADMIN cannot invite role=OWNER; records `org.invite.create` |
| DELETE | `/api/orgs/:orgId/invites/:inviteId` | OWNER/ADMIN or SUPERADMIN | New route; records `org.invite.revoke` |
| GET | `/api/orgs/:orgId/audit` | OWNER/ADMIN or SUPERADMIN | New route; paginated; read-only |

## Tests required

- MEMBER of org A calling any endpoint → 403
- User not a member of org A calling any endpoint → 403
- OWNER of org A reading/writing org B → 403
- ADMIN cannot add/invite/change to role=OWNER → 403
- OWNER can do all operations
- Bearer-authenticated call (no cookie) behaves same as same-origin cookie call for reads
- Cross-origin cookie mutation still blocked (CSRF)
- Last-manager invariant fires on demotion + removal
- `revokedAt` set on DELETE invite; re-inviting same email after revoke succeeds
- Audit log entries created for: member add/remove/role-change, invite create/revoke

## References

- nexus ADR-003 (Nexus-native management + Engram proxy)
- ADR-009 §D3 (OWNER/ADMIN per-user app-entitlement precedent)
- ADR-013 (browser SSO cookie and CSRF contract)
- ADR-005 (suite roles, org roles, and app entitlements)
- security audit 2026-06-10 (cookie CSRF gate, audit trail, HG-1 membership invariant)
