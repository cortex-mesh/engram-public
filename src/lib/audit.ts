import type { NextRequest } from "next/server";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";

// Security audit trail (audit 2026-06-10, N-4). Records authentication,
// credential, admin, and authorization-change events so an account takeover
// or admin misuse can be detected and investigated. Writes are best-effort:
// a failure to record an event must never break the request it describes.

export type AuditOutcome = "success" | "failure";

export type AuditActorType =
  | "user"
  | "admin"
  | "org_admin"
  | "internal"
  | "system"
  | "anonymous";

// Stable, greppable action names: "<subject>.<verb>[.<qualifier>]".
export type AuditAction =
  | "login.success"
  | "login.failure"
  | "logout.success"
  | "magic_link.issued"
  | "magic_link.consumed"
  | "token.exchange.success"
  | "refresh.reuse_detected"
  | "refresh.reuse_graced"
  | "password.change"
  | "password.change.blocked_oauth_only"
  | "password.set.requested"
  | "password.set"
  | "waitlist.approve"
  | "waitlist.hide"
  | "admin.user.create"
  | "admin.password.reset"
  | "org.member.add"
  | "org.member.remove"
  | "org.member.role_change"
  | "org.invite.create"
  | "org.invite.revoke"
  | "org.app_entitlement.change"
  | "org.app_entitlement.access_mode_change"
  | "org.feature_entitlement.change"
  | "user.app_entitlement.set"
  | "user.app_entitlement.delete"
  | "org.provider_credential.set"
  | "org.provider_credential.rotate"
  | "org.provider_credential.delete"
  | "org.provider_credential.test"
  | "cite.enrollment.grant"
  | "cite.enrollment.revoke"
  | "cite.enrollment.retention";

export interface AuditEvent {
  action: AuditAction;
  outcome: AuditOutcome;
  actorUserId?: string | null;
  actorType?: AuditActorType;
  targetType?: string;
  targetId?: string;
  orgId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  request?: NextRequest;
}

const MAX_USER_AGENT = 1024;

export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: event.action,
        outcome: event.outcome,
        actorUserId: event.actorUserId ?? null,
        actorType: event.actorType ?? "user",
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        orgId: event.orgId ?? null,
        ip: event.request ? getClientIp(event.request) : null,
        userAgent:
          event.request?.headers.get("user-agent")?.slice(0, MAX_USER_AGENT) ??
          null,
        reason: event.reason ?? null,
        metadata: (event.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });
  } catch (err) {
    console.error("[engram][audit] failed to record event", {
      action: event.action,
      err,
    });
  }
}
