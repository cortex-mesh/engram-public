import { prisma } from "@/lib/prisma";

export type EmailSuppressionReason = "bounced" | "complained";

export interface EmailSuppressionRecord {
  email: string;
  reason: string;
  source: string;
  eventType: string | null;
  providerMessageId: string | null;
  updatedAt: Date;
}

export function normalizeEmailAddress(email: string): string {
  return email.trim().toLowerCase();
}

export async function getEmailSuppression(email: string): Promise<EmailSuppressionRecord | null> {
  return prisma.emailSuppression.findUnique({
    where: { email: normalizeEmailAddress(email) },
    select: {
      email: true,
      reason: true,
      source: true,
      eventType: true,
      providerMessageId: true,
      updatedAt: true,
    },
  });
}

export async function suppressEmailAddress({
  email,
  reason,
  source,
  eventType,
  providerMessageId,
  rawEvent,
}: {
  email: string;
  reason: EmailSuppressionReason;
  source: string;
  eventType?: string | null;
  providerMessageId?: string | null;
  rawEvent?: unknown;
}): Promise<void> {
  const normalizedEmail = normalizeEmailAddress(email);
  await prisma.emailSuppression.upsert({
    where: { email: normalizedEmail },
    update: {
      reason,
      source,
      eventType: eventType ?? null,
      providerMessageId: providerMessageId ?? null,
      rawEvent: rawEvent === undefined ? undefined : (rawEvent as object),
    },
    create: {
      email: normalizedEmail,
      reason,
      source,
      eventType: eventType ?? null,
      providerMessageId: providerMessageId ?? null,
      rawEvent: rawEvent === undefined ? undefined : (rawEvent as object),
    },
  });
}

export function formatSuppressionForLog(record: EmailSuppressionRecord): string {
  return `${record.email} suppressed because ${record.reason}${record.eventType ? ` (${record.eventType})` : ""}`;
}
