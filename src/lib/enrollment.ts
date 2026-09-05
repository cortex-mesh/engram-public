import { randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ENROLLMENT_CLIENT_ID,
  ENROLLMENT_CONSUMER_ID,
} from "@/lib/enrollment-auth";
import { enrollmentJwsHash, signEnrollmentJws } from "@/lib/enrollment-crypto";

export const ENROLLMENT_CONTRACT_VERSION = 1;
export const ENROLLMENT_STATE_POLL_BUDGET_MS = 90_000;
export const MAX_ENROLLMENT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

// A snapshot receipt stays acknowledgeable for its signed poll budget. Pruning
// exactly at that boundary makes a legitimate in-budget acknowledgement race
// the sweep: the consumer's clock may differ (the contract already tolerates 60s
// of skew), and its request still has to reach us. Prune only past the budget
// PLUS that skew allowance, so losing the race requires being late by the
// contract's own tolerance rather than by milliseconds.
export const ENROLLMENT_RECEIPT_PRUNE_GRACE_MS = 60_000;
// A prune sweep runs on a request path, so it is bounded: it can never turn
// into a long scan that delays a snapshot response.
const ENROLLMENT_RECEIPT_PRUNE_LIMIT = 200;

type EnrollmentTransaction = Pick<
  typeof prisma,
  | "enrollment"
  | "enrollmentStream"
  | "enrollmentEvent"
  | "enrollmentConsumerAcknowledgement"
  | "enrollmentSnapshotDelivery"
>;

type StoredEnrollment = {
  id: string;
  clientId: string;
  userId: string | null;
  subjectId: string;
  status: "active" | "revoked" | "expired";
  version: number;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
};

function assertion(enrollment: StoredEnrollment, generatedAt: Date) {
  if (enrollment.clientId !== ENROLLMENT_CLIENT_ID) {
    throw new EnrollmentInputError("Enrollment client scope is invalid.");
  }
  const stateValidUntil = new Date(
    generatedAt.getTime() + ENROLLMENT_STATE_POLL_BUDGET_MS,
  );
  const status =
    enrollment.status === "active" && enrollment.expiresAt <= generatedAt
      ? "expired"
      : enrollment.status;
  return {
    enrollment_id: enrollment.id,
    subject_id: enrollment.subjectId,
    client_id: enrollment.clientId,
    status,
    version: enrollment.version,
    issued_at: generatedAt.toISOString(),
    state_valid_until: stateValidUntil.toISOString(),
    expires_at: enrollment.expiresAt.toISOString(),
    ...(enrollment.revokedAt
      ? { revoked_at: enrollment.revokedAt.toISOString() }
      : {}),
    ...(enrollment.revocationReason
      ? { revocation_reason: enrollment.revocationReason }
      : {}),
  };
}

async function appendEvent(
  tx: EnrollmentTransaction,
  enrollment: StoredEnrollment,
  kind: "enrollment.granted" | "enrollment.revoked",
) {
  if (enrollment.clientId !== ENROLLMENT_CLIENT_ID) {
    throw new EnrollmentInputError("Enrollment client scope is invalid.");
  }
  const stream = await tx.enrollmentStream.upsert({
    where: { clientId: ENROLLMENT_CLIENT_ID },
    create: { clientId: ENROLLMENT_CLIENT_ID },
    update: {},
  });
  const sequence = stream.headSequence + 1;
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const signedJws = await signEnrollmentJws({
    contract_version: ENROLLMENT_CONTRACT_VERSION,
    kind,
    client_id: enrollment.clientId,
    sequence,
    event_id: eventId,
    occurred_at: occurredAt,
    prev_event_hash: stream.headEventHash,
    enrollment: assertion(enrollment, new Date(occurredAt)),
  });
  const eventHash = await enrollmentJwsHash(signedJws);
  await tx.enrollmentEvent.create({
    data: {
      id: eventId,
      clientId: ENROLLMENT_CLIENT_ID,
      enrollmentId: enrollment.id,
      sequence,
      kind,
      eventHash,
      previousHash: stream.headEventHash,
      signedJws,
    },
  });
  await tx.enrollmentStream.update({
    where: { clientId: ENROLLMENT_CLIENT_ID },
    data: {
      headSequence: sequence,
      headEventId: eventId,
      headEventHash: eventHash,
    },
  });
  return { sequence, eventId, eventHash, signedJws };
}

export async function grantEnrollment({
  userId,
  expiresAt,
}: {
  userId: string;
  expiresAt: Date;
}) {
  const now = new Date();
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new EnrollmentInputError(
      "Enrollment expiry must be a future timestamp.",
    );
  }
  if (expiresAt.getTime() > now.getTime() + MAX_ENROLLMENT_LIFETIME_MS) {
    throw new EnrollmentInputError("Enrollment expiry must be within 90 days.");
  }
  return withEnrollmentWriteRetry(async () =>
    prisma.$transaction(
      async (tx) => {
        const current = await tx.enrollment.findUnique({
          where: {
            clientId_subjectId: {
              clientId: ENROLLMENT_CLIENT_ID,
              subjectId: userId,
            },
          },
        });
        if (
          current?.status === "active" &&
          current.expiresAt.getTime() === expiresAt.getTime()
        ) {
          return { enrollment: current, event: null, idempotent: true };
        }
        const enrollment = current
          ? await tx.enrollment.update({
              where: { id: current.id },
              data: {
                status: "active",
                version: { increment: 1 },
                expiresAt,
                revokedAt: null,
                revocationReason: null,
              },
            })
          : await tx.enrollment.create({
              data: {
                clientId: ENROLLMENT_CLIENT_ID,
                userId,
                subjectId: userId,
                expiresAt,
              },
            });
        const event = await appendEvent(tx, enrollment, "enrollment.granted");
        return { enrollment, event, idempotent: false };
      },
      { isolationLevel: "Serializable" },
    ),
  );
}

export async function revokeEnrollment({
  userId,
  reason,
}: {
  userId: string;
  reason?: string;
}) {
  return withEnrollmentWriteRetry(async () =>
    prisma.$transaction(
      async (tx) => {
        const current = await tx.enrollment.findUnique({
          where: {
            clientId_subjectId: {
              clientId: ENROLLMENT_CLIENT_ID,
              subjectId: userId,
            },
          },
        });
        if (!current) throw new EnrollmentNotFoundError();
        if (current.status === "revoked")
          return { enrollment: current, event: null, idempotent: true };
        const enrollment = await tx.enrollment.update({
          where: { id: current.id },
          data: {
            status: "revoked",
            version: { increment: 1 },
            revokedAt: new Date(),
            revocationReason: reason || null,
          },
        });
        const event = await appendEvent(tx, enrollment, "enrollment.revoked");
        return { enrollment, event, idempotent: false };
      },
      { isolationLevel: "Serializable" },
    ),
  );
}

export async function getEnrollmentEvents(
  afterSequence: number,
  limit: number,
) {
  // Capture stream and page in the same repeatable-read snapshot. The explicit
  // upper bound prevents a concurrent append from leaking past the signed head.
  return prisma.$transaction(
    async (tx) => {
      const stream = await tx.enrollmentStream.findUnique({
        where: { clientId: ENROLLMENT_CLIENT_ID },
      });
      const headSequence = stream?.headSequence ?? 0;
      if (afterSequence > headSequence) throw new EnrollmentCursorError();
      if (afterSequence < Math.max(0, (stream?.retainedFrom ?? 1) - 1))
        throw new EnrollmentCursorExpiredError();
      const events = await tx.enrollmentEvent.findMany({
        where: {
          clientId: ENROLLMENT_CLIENT_ID,
          sequence: { gt: afterSequence, lte: headSequence },
        },
        orderBy: { sequence: "asc" },
        take: limit,
      });
      return { headSequence, events };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

/** Rotation retention lifecycle: after the old verification key is retired,
 * remove events below the next cursor floor but always retain the immutable
 * current head. Delayed consumers then receive CURSOR_EXPIRED and reconcile
 * from a currently verifiable signed snapshot. */
export async function retireEnrollmentEventsBefore(
  firstRetainedSequence: number,
) {
  if (!Number.isSafeInteger(firstRetainedSequence) || firstRetainedSequence < 1)
    throw new EnrollmentInputError(
      "Retention floor must be a positive sequence.",
    );
  return prisma.$transaction(
    async (tx) => {
      const stream = await tx.enrollmentStream.findUnique({
        where: { clientId: ENROLLMENT_CLIENT_ID },
      });
      if (
        !stream ||
        firstRetainedSequence > stream.headSequence ||
        firstRetainedSequence < stream.retainedFrom
      )
        throw new EnrollmentInputError(
          "Retention floor is outside the current stream.",
        );
      const acknowledgement =
        await tx.enrollmentConsumerAcknowledgement.findUnique({
          where: {
            consumerId_clientId: {
              consumerId: ENROLLMENT_CONSUMER_ID,
              clientId: ENROLLMENT_CLIENT_ID,
            },
          },
        });
      if (
        !acknowledgement ||
        acknowledgement.headSequence < firstRetainedSequence - 1
      ) {
        throw new EnrollmentInputError(
          "Retention requires the consumer acknowledgement to reach the new cursor floor.",
        );
      }
      if (!acknowledgement.lastSnapshotJwsHash) {
        throw new EnrollmentInputError(
          "Retention requires an acknowledged snapshot at or above the new cursor floor.",
        );
      }
      const snapshot = await tx.enrollmentSnapshotDelivery.findUnique({
        where: {
          consumerId_clientId_snapshotJwsHash: {
            consumerId: ENROLLMENT_CONSUMER_ID,
            clientId: ENROLLMENT_CLIENT_ID,
            snapshotJwsHash: acknowledgement.lastSnapshotJwsHash,
          },
        },
      });
      if (!snapshot || snapshot.headSequence < firstRetainedSequence) {
        throw new EnrollmentInputError(
          "Retention requires an acknowledged snapshot at or above the new cursor floor.",
        );
      }
      await tx.enrollmentEvent.deleteMany({
        where: {
          clientId: ENROLLMENT_CLIENT_ID,
          sequence: { lt: firstRetainedSequence },
        },
      });
      return tx.enrollmentStream.update({
        where: { clientId: ENROLLMENT_CLIENT_ID },
        data: { retainedFrom: firstRetainedSequence },
      });
    },
    { isolationLevel: "Serializable" },
  );
}

export async function markDelivered(
  events: Array<{ id: string; sequence: number; eventHash: string }>,
) {
  await withEnrollmentWriteRetry(() =>
    prisma.$transaction(
      events.map((event) =>
        prisma.enrollmentConsumerDelivery.upsert({
          where: {
            consumerId_clientId_sequence: {
              consumerId: ENROLLMENT_CONSUMER_ID,
              clientId: ENROLLMENT_CLIENT_ID,
              sequence: event.sequence,
            },
          },
          create: {
            consumerId: ENROLLMENT_CONSUMER_ID,
            clientId: ENROLLMENT_CLIENT_ID,
            sequence: event.sequence,
            eventId: event.id,
            eventHash: event.eventHash,
          },
          update: {},
        }),
      ),
    ),
  );
}

export async function currentSnapshot() {
  return prisma.$transaction(
    async (tx) => {
      const stream = await tx.enrollmentStream.findUnique({
        where: { clientId: ENROLLMENT_CLIENT_ID },
      });
      const enrollments = await tx.enrollment.findMany({
        where: { clientId: ENROLLMENT_CLIENT_ID },
        orderBy: { id: "asc" },
      });
      const headSequence = stream?.headSequence ?? 0;
      const headEventId = stream?.headEventId ?? null;
      const headEventHash = stream?.headEventHash ?? null;
      const generatedAt = new Date();
      const stateValidUntil = new Date(
        generatedAt.getTime() + ENROLLMENT_STATE_POLL_BUDGET_MS,
      );
      const signedJws = await signEnrollmentJws({
        contract_version: ENROLLMENT_CONTRACT_VERSION,
        kind: "enrollment.snapshot",
        client_id: ENROLLMENT_CLIENT_ID,
        generated_at: generatedAt.toISOString(),
        issued_at: generatedAt.toISOString(),
        state_valid_until: stateValidUntil.toISOString(),
        head_sequence: headSequence,
        head_event_id: headEventId,
        head_event_hash: headEventHash,
        enrollments: enrollments.map((enrollment) =>
          assertion(enrollment, generatedAt),
        ),
      });
      return { headSequence, headEventId, headEventHash, signedJws };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export async function markSnapshotHeadDelivered(
  headSequence: number,
  headEventId: string | null,
  headEventHash: string | null,
  signedJws: string,
) {
  if (headSequence !== 0) {
    if (!headEventId || !headEventHash)
      throw new EnrollmentAcknowledgementError(
        "Snapshot head is inconsistent.",
      );
    const event = await prisma.enrollmentEvent.findUnique({
      where: { id: headEventId },
    });
    if (
      !event ||
      event.sequence !== headSequence ||
      event.eventHash !== headEventHash
    ) {
      throw new EnrollmentAcknowledgementError(
        "Snapshot head is inconsistent.",
      );
    }
  }
  const snapshotJwsHash = enrollmentJwsHash(signedJws);

  // Recording a delivery receipt is a single idempotent insert against a unique
  // key. It protects no cross-row invariant, so it needs neither an explicit
  // transaction nor serializable isolation — one statement is already atomic,
  // and the unique key makes a repeat a no-op.
  //
  // It used to run as a Serializable transaction that ALSO read the
  // acknowledgement and pruned stale receipts. Because every snapshot is signed
  // at request time, concurrent polls write distinct rows, so they never
  // contended on the key — they contended on the isolation level itself.
  // Measured on real PostgreSQL, concurrent callers hit
  // TransactionWriteConflict (P2034) ~66% of the time with the prune removed
  // and ~87% with it, and the bounded retry converted whatever it could not
  // absorb into a 503. Under ADR-034 §4/§8.5 a 503 is a hard deny, so lock
  // contention on a read endpoint denied real users. Isolation had been copied
  // from the operations that genuinely need it — the gap-free chain append
  // (§3) and the retention advance (§6) — to one that does not.
  try {
    await prisma.enrollmentSnapshotDelivery.create({
      data: {
        consumerId: ENROLLMENT_CONSUMER_ID,
        clientId: ENROLLMENT_CLIENT_ID,
        headSequence,
        headEventId,
        headEventHash,
        snapshotJwsHash,
        deliveredAt: new Date(),
      },
    });
  } catch (cause) {
    // A unique violation means this exact signed snapshot was already
    // receipted. That is the idempotent outcome, not a failure.
    if (
      !(
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2002"
      )
    )
      throw cause;
  }

  // Collect stale receipts on the way out. Pruning here was never the mistake
  // — doing it INSIDE the receipt's serializable transaction was. Outside it,
  // at the default isolation level and bounded, the sweep cannot contend with
  // concurrent deliveries, and keeping it on this path bounds growth even for
  // a consumer that polls forever without acknowledging. It is best-effort and
  // cannot fail the delivery it follows.
  await pruneStaleSnapshotReceipts();
}

/**
 * Delete snapshot receipts that are past their acknowledgeable life.
 *
 * Runs OUTSIDE any transaction and at the default isolation level: it is
 * maintenance, not part of any invariant, and must never contend with the
 * delivery or acknowledgement paths. Bounded by
 * `ENROLLMENT_RECEIPT_PRUNE_LIMIT` so it cannot become a long scan on a
 * request path, and best-effort — a failure here is logged and swallowed,
 * because failing to collect garbage must never deny a user (ADR-034 §4).
 */
export async function pruneStaleSnapshotReceipts(): Promise<number> {
  try {
    const acknowledgement =
      await prisma.enrollmentConsumerAcknowledgement.findUnique({
        where: {
          consumerId_clientId: {
            consumerId: ENROLLMENT_CONSUMER_ID,
            clientId: ENROLLMENT_CLIENT_ID,
          },
        },
      });
    const staleBefore = new Date(
      Date.now() -
        ENROLLMENT_STATE_POLL_BUDGET_MS -
        ENROLLMENT_RECEIPT_PRUNE_GRACE_MS,
    );
    // The retained recovery receipt proves the consumer can rebuild its state
    // from still-verifiable signed material (ADR-034 §6). Never prune it.
    const retainHashes = [acknowledgement?.lastSnapshotJwsHash].filter(
      (hash): hash is string => Boolean(hash),
    );
    const doomed = await prisma.enrollmentSnapshotDelivery.findMany({
      where: {
        consumerId: ENROLLMENT_CONSUMER_ID,
        clientId: ENROLLMENT_CLIENT_ID,
        deliveredAt: { lt: staleBefore },
        snapshotJwsHash: { notIn: retainHashes },
      },
      select: { id: true },
      take: ENROLLMENT_RECEIPT_PRUNE_LIMIT,
    });
    if (doomed.length === 0) return 0;
    const { count } = await prisma.enrollmentSnapshotDelivery.deleteMany({
      where: { id: { in: doomed.map((row) => row.id) } },
    });
    return count;
  } catch (cause) {
    console.error("Enrollment receipt prune failed (non-fatal):", cause);
    return 0;
  }
}

export const enrollmentTestHooks: {
  afterAcknowledgementRead?: () => Promise<void>;
} = {};

const ACKNOWLEDGEMENT_RETRY_ATTEMPTS = 5;
const ENROLLMENT_WRITE_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 5;

function isRetryableAcknowledgementWrite(cause: unknown): boolean {
  return (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    (cause.code === "P2034" || cause.code === "P2002")
  );
}

/**
 * Wait a jittered, exponentially growing interval before the next attempt.
 *
 * Retrying a serialization failure immediately re-collides with the very
 * writers it just lost to — every loser wakes at once and reproduces the
 * conflict. Jitter is what actually spreads them; the growth bounds the worst
 * case. Delays stay small (5ms base) because these are single-statement
 * conflicts, not long transactions.
 */
async function backoffWithJitter(attempt: number): Promise<void> {
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  await new Promise((resolve) =>
    setTimeout(resolve, base + Math.random() * base),
  );
}

async function withEnrollmentWriteRetry<T>(work: () => Promise<T>): Promise<T> {
  for (
    let attempt = 0;
    attempt < ENROLLMENT_WRITE_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await work();
    } catch (cause) {
      if (
        !isRetryableAcknowledgementWrite(cause) ||
        attempt === ENROLLMENT_WRITE_RETRY_ATTEMPTS - 1
      )
        throw cause;
      await backoffWithJitter(attempt);
    }
  }
  throw new Error("Enrollment write retry loop exhausted.");
}

async function acknowledgeEnrollmentHeadOnce(input: {
  headSequence: number;
  headEventId: string | null;
  headEventHash: string | null;
  headJwsHash: string;
}) {
  return prisma.$transaction(
    async (tx) => {
      const key = {
        consumerId_clientId: {
          consumerId: ENROLLMENT_CONSUMER_ID,
          clientId: ENROLLMENT_CLIENT_ID,
        },
      };
      const existing = await tx.enrollmentConsumerAcknowledgement.findUnique({
        where: key,
      });
      if (process.env.NODE_ENV === "test")
        await enrollmentTestHooks.afterAcknowledgementRead?.();
      const snapshotDelivery = await tx.enrollmentSnapshotDelivery.findUnique({
        where: {
          consumerId_clientId_snapshotJwsHash: {
            consumerId: ENROLLMENT_CONSUMER_ID,
            clientId: ENROLLMENT_CLIENT_ID,
            snapshotJwsHash: input.headJwsHash,
          },
        },
      });
      const isSnapshotAcknowledgement = Boolean(
        snapshotDelivery &&
        snapshotDelivery.headSequence === input.headSequence &&
        snapshotDelivery.headEventId === input.headEventId &&
        snapshotDelivery.headEventHash === input.headEventHash,
      );
      if (
        existing &&
        existing.headSequence === input.headSequence &&
        existing.headEventId === input.headEventId &&
        existing.headEventHash === input.headEventHash
      ) {
        if (existing.headJwsHash === input.headJwsHash) return existing;
        if (!isSnapshotAcknowledgement) {
          throw new EnrollmentAcknowledgementError(
            "Acknowledgement hash conflicts with the durable receipt.",
          );
        }
        const refreshed = await tx.enrollmentConsumerAcknowledgement.updateMany(
          {
            where: {
              id: existing.id,
              headSequence: existing.headSequence,
              headJwsHash: existing.headJwsHash,
            },
            data: {
              headJwsHash: input.headJwsHash,
              lastSnapshotJwsHash: input.headJwsHash,
              acknowledgedAt: new Date(),
            },
          },
        );
        if (refreshed.count !== 1)
          throw new EnrollmentAcknowledgementError(
            "Acknowledgement changed concurrently; retry from durable state.",
          );
        return tx.enrollmentConsumerAcknowledgement.findUniqueOrThrow({
          where: key,
        });
      }
      if (existing && existing.headSequence >= input.headSequence)
        throw new EnrollmentAcknowledgementError(
          "Acknowledgement would regress.",
        );
      if (input.headSequence === 0) {
        if (input.headEventId || input.headEventHash)
          throw new EnrollmentAcknowledgementError(
            "Empty head must not name an event.",
          );
        const stream = await tx.enrollmentStream.findUnique({
          where: { clientId: ENROLLMENT_CLIENT_ID },
        });
        if ((stream?.headSequence ?? 0) !== 0)
          throw new EnrollmentAcknowledgementError(
            "Empty acknowledgement is stale.",
          );
        if (!isSnapshotAcknowledgement)
          throw new EnrollmentAcknowledgementError(
            "Empty acknowledgement snapshot was not delivered.",
          );
      } else {
        if (!input.headEventId || !input.headEventHash)
          throw new EnrollmentAcknowledgementError(
            "Acknowledgement does not bind to its delivered head.",
          );
        if (isSnapshotAcknowledgement) {
          // The matching delivery was verified above.
        } else {
          const delivery = await tx.enrollmentConsumerDelivery.findUnique({
            where: {
              consumerId_clientId_sequence: {
                consumerId: ENROLLMENT_CONSUMER_ID,
                clientId: ENROLLMENT_CLIENT_ID,
                sequence: input.headSequence,
              },
            },
          });
          if (
            !delivery ||
            delivery.eventId !== input.headEventId ||
            delivery.eventHash !== input.headEventHash
          )
            throw new EnrollmentAcknowledgementError(
              "Acknowledgement has not been delivered.",
            );
          if (input.headSequence !== (existing?.headSequence ?? 0) + 1)
            throw new EnrollmentAcknowledgementError(
              "Acknowledgement would skip an event; reconcile from a signed snapshot.",
            );
        }
      }
      if (!existing) {
        return tx.enrollmentConsumerAcknowledgement.create({
          data: {
            consumerId: ENROLLMENT_CONSUMER_ID,
            clientId: ENROLLMENT_CLIENT_ID,
            headSequence: input.headSequence,
            headEventId: input.headEventId,
            headEventHash: input.headEventHash,
            headJwsHash: input.headJwsHash,
            ...(isSnapshotAcknowledgement
              ? { lastSnapshotJwsHash: input.headJwsHash }
              : {}),
          },
        });
      }
      // The sequence predicate is a compare-and-set: a concurrent later receipt
      // wins, and the loser reports conflict rather than false success.
      const advanced = await tx.enrollmentConsumerAcknowledgement.updateMany({
        where: { id: existing.id, headSequence: existing.headSequence },
        data: {
          headSequence: input.headSequence,
          headEventId: input.headEventId,
          headEventHash: input.headEventHash,
          headJwsHash: input.headJwsHash,
          ...(isSnapshotAcknowledgement
            ? { lastSnapshotJwsHash: input.headJwsHash }
            : {}),
          acknowledgedAt: new Date(),
        },
      });
      if (advanced.count !== 1)
        throw new EnrollmentAcknowledgementError(
          "Acknowledgement changed concurrently; retry from durable state.",
        );
      return tx.enrollmentConsumerAcknowledgement.findUniqueOrThrow({
        where: key,
      });
    },
    { isolationLevel: "Serializable" },
  );
}

export async function acknowledgeEnrollmentHead(input: {
  headSequence: number;
  headEventId: string | null;
  headEventHash: string | null;
  headJwsHash: string;
}) {
  // Serializable PostgreSQL transactions can abort a loser after two
  // identical first acknowledgements both observe no row. Retry a bounded
  // number of only those database races; the retry reads the durable winner
  // and remains strict about conflicting acknowledgement content.
  //
  // Unlike delivery, this write DOES need serializable isolation — it enforces
  // no-regression and no-gap rules across the acknowledgement and delivery
  // rows — so the retry stays. It backs off with jitter because an immediate
  // retry re-collides with the same losers it just raced.
  for (let attempt = 0; attempt < ACKNOWLEDGEMENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const result = await acknowledgeEnrollmentHeadOnce(input);
      // Primary prune trigger. The acknowledgement is what changes which
      // receipt must be retained, and it is naturally paced by the consumer's
      // poll cadence, so it is the right moment to collect. Deliberately after
      // the transaction commits, never inside it.
      await pruneStaleSnapshotReceipts();
      return result;
    } catch (cause) {
      if (
        !isRetryableAcknowledgementWrite(cause) ||
        attempt === ACKNOWLEDGEMENT_RETRY_ATTEMPTS - 1
      )
        throw cause;
      await backoffWithJitter(attempt);
    }
  }
  throw new Error("Acknowledgement retry loop exhausted.");
}

export class EnrollmentInputError extends Error {}
export class EnrollmentNotFoundError extends Error {}
export class EnrollmentCursorError extends Error {}
export class EnrollmentCursorExpiredError extends Error {}
export class EnrollmentAcknowledgementError extends Error {}
