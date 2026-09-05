import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import {
  compactVerify,
  decodeProtectedHeader,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importSPKI,
} from "jose";
import { NextRequest } from "next/server";

import { GET as getSnapshot } from "@/app/api/internal/enrollment/v1/snapshot/route";
import { GET as getEventsRoute } from "@/app/api/internal/enrollment/v1/events/route";
import {
  EnrollmentAcknowledgementError,
  EnrollmentCursorExpiredError,
  acknowledgeEnrollmentHead,
  enrollmentTestHooks,
  getEnrollmentEvents,
  grantEnrollment,
  revokeEnrollment,
  retireEnrollmentEventsBefore,
  pruneStaleSnapshotReceipts,
  ENROLLMENT_STATE_POLL_BUDGET_MS,
  ENROLLMENT_RECEIPT_PRUNE_GRACE_MS,
} from "@/lib/enrollment";
import { enrollmentJwsHash } from "@/lib/enrollment-crypto";
import { prisma } from "@/lib/prisma";
import contract from "../../docs/contracts/cite-enrollment/v1.openapi.json";

const saved = { ...process.env };

type KeyMaterial = { kid: string; privatePem: string; publicPem: string };
let k1: KeyMaterial;
let k2: KeyMaterial;
const ajv = new Ajv({ allErrors: true });
ajv.addSchema(contract, "cite-enrollment-contract");

function expectContractSchema(
  name: "SnapshotResponse" | "EventPageResponse" | "event" | "snapshot",
  value: unknown,
) {
  const validate = ajv.getSchema(
    `cite-enrollment-contract#/components/schemas/${name}`,
  );
  if (!validate) throw new Error(`Missing ${name} schema`);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function expectSignedPayloadSchema(
  name: "event" | "snapshot",
  signedJws: string,
) {
  const [, payload] = signedJws.split(".");
  expect(payload).toBeTruthy();
  const schema = (
    contract as {
      "x-signed-message-payloads": Record<string, object>;
      components: object;
    }
  )["x-signed-message-payloads"][name];
  const validate = ajv.compile({ ...schema, components: contract.components });
  const decoded = JSON.parse(
    Buffer.from(payload!, "base64url").toString("utf8"),
  );
  expect(validate(decoded), JSON.stringify(validate.errors)).toBe(true);
}

function configure(active: KeyMaterial, overlap?: KeyMaterial) {
  Object.assign(process.env, {
    ENGRAM_AXON_ENROLLMENT_API_KEY: "postgres-axon-key",
    ENGRAM_ENROLLMENT_SIGNING_KEY_ID: active.kid,
    ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY: active.privatePem,
    ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY: active.publicPem,
    ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "2020-01-01T00:00:00.000Z",
    ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "2099-01-01T00:00:00.000Z",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: overlap?.kid ?? "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: overlap?.publicPem ?? "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: overlap
      ? "2020-01-01T00:00:00.000Z"
      : "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: overlap
      ? "2099-01-01T00:00:00.000Z"
      : "",
  });
}

function request(headers: HeadersInit = {}) {
  return new NextRequest(
    "https://login.dev.ctxhost.com/api/internal/enrollment/v1/snapshot",
    {
      headers: { Authorization: "Bearer postgres-axon-key", ...headers },
    },
  );
}

function eventRequest(afterSequence = 0, headers: HeadersInit = {}) {
  return new NextRequest(
    `https://login.dev.ctxhost.com/api/internal/enrollment/v1/events?after_sequence=${afterSequence}&limit=100`,
    {
      headers: { Authorization: "Bearer postgres-axon-key", ...headers },
    },
  );
}

async function verifiedSnapshotAllows(
  signedJws: string,
  publicPem: string,
  now: Date,
): Promise<boolean> {
  const publicKey = await importSPKI(publicPem, "RS256");
  const verified = await compactVerify(signedJws, publicKey, {
    algorithms: ["RS256"],
  });
  const payload = JSON.parse(new TextDecoder().decode(verified.payload)) as {
    state_valid_until?: string;
  };
  return (
    typeof payload.state_valid_until === "string" &&
    now.getTime() < new Date(payload.state_valid_until).getTime()
  );
}

async function key(kid: string): Promise<KeyMaterial> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  return {
    kid,
    privatePem: await exportPKCS8(pair.privateKey),
    publicPem: await exportSPKI(pair.publicKey),
  };
}

function futureExpiry(): Date {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

async function clearEnrollmentState() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EnrollmentConsumerAcknowledgement",
      "EnrollmentSnapshotDelivery",
      "EnrollmentConsumerDelivery",
      "EnrollmentEvent",
      "EnrollmentStream",
      "Enrollment"
    RESTART IDENTITY CASCADE
  `);
}

describe("Cite enrollment contract against real PostgreSQL", () => {
  beforeAll(async () => {
    k1 = await key("k1");
    k2 = await key("k2");
    configure(k1);
    await clearEnrollmentState();
  });

  afterAll(() => {
    process.env = saved;
  });

  it("migrates and proves fresh snapshots, K1-to-K2 recovery, and snapshot acknowledgement", async () => {
    const user = await prisma.user.create({
      data: {
        username: "cite-postgres-user",
        email: "cite-postgres-user@example.test",
      },
    });
    const expiresAt = futureExpiry();
    const granted = await grantEnrollment({ userId: user.id, expiresAt });
    expect(granted.event?.sequence).toBe(1);

    const events = await getEnrollmentEvents(0, 100);
    expect(events).toMatchObject({
      headSequence: 1,
      events: [{ sequence: 1, id: granted.event?.eventId }],
    });

    const eventResponse = await getEventsRoute(eventRequest());
    expect(eventResponse.status).toBe(200);
    const eventBody = (await eventResponse.json()) as {
      events: Array<{ signed_jws: string }>;
    };
    expectContractSchema("EventPageResponse", eventBody);
    expect(decodeProtectedHeader(eventBody.events[0].signed_jws)).toMatchObject(
      {
        alg: "RS256",
        typ: "engram-enrollment+jws",
        kid: "k1",
        contract_version: 1,
      },
    );
    expectSignedPayloadSchema("event", eventBody.events[0].signed_jws);

    const first = await getSnapshot(request());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      signed_jws: string;
      head_sequence: number;
    };
    expectContractSchema("SnapshotResponse", firstBody);
    expect(decodeProtectedHeader(firstBody.signed_jws)).toMatchObject({
      alg: "RS256",
      typ: "engram-enrollment+jws",
      kid: "k1",
      contract_version: 1,
    });
    expectSignedPayloadSchema("snapshot", firstBody.signed_jws);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("etag")).toBeNull();
    expect(await prisma.enrollmentSnapshotDelivery.count()).toBe(1);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(expiresAt.getTime() + 1));
    const expired = await getSnapshot(request());
    vi.useRealTimers();
    expect(expired.status).toBe(200);
    expect(await prisma.enrollmentSnapshotDelivery.count()).toBe(1);

    configure(k2, k1);
    const rotated = await revokeEnrollment({
      userId: user.id,
      reason: "rotation proof",
    });
    expect(rotated.event?.sequence).toBe(2);
    const resigned = await getSnapshot(request());
    expect(resigned.status).toBe(200);
    const resignedBody = (await resigned.json()) as {
      signed_jws: string;
      head_sequence: number;
      head_event_id: string;
      head_event_hash: string;
    };
    expect(resignedBody.head_sequence).toBe(2);
    expect(await prisma.enrollmentSnapshotDelivery.count()).toBe(2);

    const k2Hash = await enrollmentJwsHash(resignedBody.signed_jws);
    const acknowledged = await acknowledgeEnrollmentHead({
      headSequence: resignedBody.head_sequence,
      headEventId: resignedBody.head_event_id,
      headEventHash: resignedBody.head_event_hash,
      headJwsHash: k2Hash,
    });
    expect(acknowledged).toMatchObject({
      headSequence: 2,
      headJwsHash: k2Hash,
    });
    await retireEnrollmentEventsBefore(2);
    await expect(getEnrollmentEvents(0, 100)).rejects.toBeInstanceOf(
      EnrollmentCursorExpiredError,
    );
    await expect(retireEnrollmentEventsBefore(3)).rejects.toThrow(
      "outside the current stream",
    );

    // K1 is retired: it is removed from publication, while the K2 snapshot is
    // still independently verifiable and can be durably acknowledged.
    configure(k2);
    const k2Public = await importSPKI(k2.publicPem, "RS256");
    await expect(
      compactVerify(resignedBody.signed_jws, k2Public, {
        algorithms: ["RS256"],
      }),
    ).resolves.toBeDefined();
    const repeatedAcknowledgement = await acknowledgeEnrollmentHead({
      headSequence: resignedBody.head_sequence,
      headEventId: resignedBody.head_event_id,
      headEventHash: resignedBody.head_event_hash,
      headJwsHash: k2Hash,
    });
    expect(repeatedAcknowledgement).toMatchObject({
      headSequence: 2,
      headJwsHash: k2Hash,
    });

    await expect(
      prisma.user.delete({ where: { id: user.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.enrollment.findUnique({ where: { id: granted.enrollment.id } }),
    ).resolves.toMatchObject({
      userId: user.id,
      subjectId: user.id,
      status: "revoked",
    });
  });

  it("makes a signature-valid acknowledged snapshot deny after its signed poll budget elapses", async () => {
    await clearEnrollmentState();
    configure(k2);
    const user = await prisma.user.create({
      data: {
        username: "cite-freshness-user",
        email: "cite-freshness-user@example.test",
      },
    });
    await grantEnrollment({ userId: user.id, expiresAt: futureExpiry() });
    const response = await getSnapshot(request());
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      signed_jws: string;
      head_sequence: number;
      head_event_id: string;
      head_event_hash: string;
    };
    const snapshotHash = await enrollmentJwsHash(snapshot.signed_jws);
    await acknowledgeEnrollmentHead({
      headSequence: snapshot.head_sequence,
      headEventId: snapshot.head_event_id,
      headEventHash: snapshot.head_event_hash,
      headJwsHash: snapshotHash,
    });
    expect(await prisma.enrollmentConsumerAcknowledgement.count()).toBe(1);

    const verified = await compactVerify(
      snapshot.signed_jws,
      await importSPKI(k2.publicPem, "RS256"),
      { algorithms: ["RS256"] },
    );
    const payload = JSON.parse(new TextDecoder().decode(verified.payload)) as {
      generated_at: string;
      state_valid_until: string;
    };
    expect(
      new Date(payload.state_valid_until).getTime() -
        new Date(payload.generated_at).getTime(),
    ).toBe(90_000);
    expect(
      await verifiedSnapshotAllows(
        snapshot.signed_jws,
        k2.publicPem,
        new Date(payload.generated_at),
      ),
    ).toBe(true);
    expect(
      await verifiedSnapshotAllows(
        snapshot.signed_jws,
        k2.publicPem,
        new Date(new Date(payload.state_valid_until).getTime() + 1),
      ),
    ).toBe(false);
  });

  it("retains the last acknowledged snapshot through later event acknowledgements and bounds receipts", async () => {
    await clearEnrollmentState();
    configure(k2);
    const user = await prisma.user.create({
      data: {
        username: "cite-retention-user",
        email: "cite-retention-user@example.test",
      },
    });
    await grantEnrollment({ userId: user.id, expiresAt: futureExpiry() });
    await revokeEnrollment({ userId: user.id, reason: "retention proof" });
    await expect(retireEnrollmentEventsBefore(2)).rejects.toThrow(
      "consumer acknowledgement",
    );

    const response = await getSnapshot(request());
    const snapshot = (await response.json()) as {
      signed_jws: string;
      head_sequence: number;
      head_event_id: string;
      head_event_hash: string;
    };
    await acknowledgeEnrollmentHead({
      headSequence: snapshot.head_sequence,
      headEventId: snapshot.head_event_id,
      headEventHash: snapshot.head_event_hash,
      headJwsHash: await enrollmentJwsHash(snapshot.signed_jws),
    });
    await grantEnrollment({ userId: user.id, expiresAt: futureExpiry() });
    const eventResponse = await getEventsRoute(eventRequest(2));
    const event = (
      (await eventResponse.json()) as {
        events: Array<{
          sequence: number;
          event_id: string;
          event_hash: string;
        }>;
      }
    ).events[0]!;
    await acknowledgeEnrollmentHead({
      headSequence: event.sequence,
      headEventId: event.event_id,
      headEventHash: event.event_hash,
      headJwsHash: event.event_hash,
    });
    await expect(
      prisma.enrollmentConsumerAcknowledgement.findFirst(),
    ).resolves.toMatchObject({
      headSequence: 3,
      lastSnapshotJwsHash: await enrollmentJwsHash(snapshot.signed_jws),
    });
    const repeatedSnapshots = await Promise.all([
      getSnapshot(request()),
      getSnapshot(request()),
      getSnapshot(request()),
    ]);
    expect(repeatedSnapshots.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    const concurrentSnapshots = await Promise.all(
      repeatedSnapshots.map(
        async (response) =>
          response.json() as Promise<{
            signed_jws: string;
            head_sequence: number;
            head_event_id: string;
            head_event_hash: string;
          }>,
      ),
    );
    for (const delivered of concurrentSnapshots) {
      await expect(
        acknowledgeEnrollmentHead({
          headSequence: delivered.head_sequence,
          headEventId: delivered.head_event_id,
          headEventHash: delivered.head_event_hash,
          headJwsHash: enrollmentJwsHash(delivered.signed_jws),
        }),
      ).resolves.toMatchObject({ headSequence: 3 });
    }
    // Past the poll budget AND the skew grace: a receipt this old can no longer
    // arrive as an in-budget acknowledgement, so it is collectable. The grace
    // is why this is no longer budget+1 — pruning exactly at the budget let a
    // legitimate late-but-in-budget acknowledgement lose to the sweep.
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date(
        Date.now() +
          ENROLLMENT_STATE_POLL_BUDGET_MS +
          ENROLLMENT_RECEIPT_PRUNE_GRACE_MS +
          1,
      ),
    );
    await expect(getSnapshot(request())).resolves.toMatchObject({
      status: 200,
    });
    vi.useRealTimers();
    expect(await prisma.enrollmentSnapshotDelivery.count()).toBeLessThanOrEqual(
      2,
    );
    await expect(retireEnrollmentEventsBefore(2)).resolves.toMatchObject({
      retainedFrom: 2,
    });
  });

  it("serializes concurrent grants into one gap-free stream", async () => {
    await clearEnrollmentState();
    configure(k2);
    const [first, second] = await Promise.all([
      prisma.user.create({
        data: {
          username: "cite-concurrent-one",
          email: "cite-concurrent-one@example.test",
        },
      }),
      prisma.user.create({
        data: {
          username: "cite-concurrent-two",
          email: "cite-concurrent-two@example.test",
        },
      }),
    ]);
    const results = await Promise.all([
      grantEnrollment({ userId: first.id, expiresAt: futureExpiry() }),
      grantEnrollment({ userId: second.id, expiresAt: futureExpiry() }),
    ]);
    expect(results.map((result) => result.event?.sequence).sort()).toEqual([
      1, 2,
    ]);
    await expect(
      prisma.enrollmentEvent.findMany({
        where: { clientId: "axon-web" },
        orderBy: { sequence: "asc" },
      }),
    ).resolves.toMatchObject([{ sequence: 1 }, { sequence: 2 }]);
  });

  it("denies arbitrary empty-head hashes and makes barrier-synchronized first acknowledgements idempotent", async () => {
    await clearEnrollmentState();
    configure(k2);

    const empty = await getSnapshot(request());
    expect(empty.status).toBe(200);
    const body = (await empty.json()) as { signed_jws: string };
    const deliveredHash = await enrollmentJwsHash(body.signed_jws);

    await expect(
      acknowledgeEnrollmentHead({
        headSequence: 0,
        headEventId: null,
        headEventHash: null,
        headJwsHash: "x".repeat(43),
      }),
    ).rejects.toBeInstanceOf(EnrollmentAcknowledgementError);

    let arrivals = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    enrollmentTestHooks.afterAcknowledgementRead = async () => {
      arrivals += 1;
      if (arrivals === 2) release?.();
      if (arrivals <= 2) await barrier;
    };
    const attempts = await Promise.allSettled([
      acknowledgeEnrollmentHead({
        headSequence: 0,
        headEventId: null,
        headEventHash: null,
        headJwsHash: deliveredHash,
      }),
      acknowledgeEnrollmentHead({
        headSequence: 0,
        headEventId: null,
        headEventHash: null,
        headJwsHash: deliveredHash,
      }),
    ]);
    enrollmentTestHooks.afterAcknowledgementRead = undefined;
    // Both requests may observe the winner as an idempotent retry, but only a
    // single durable acknowledgement row may ever exist.
    const acknowledgements = attempts.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(
      new Set(acknowledgements.map((acknowledgement) => acknowledgement.id))
        .size,
    ).toBe(1);
    expect(arrivals).toBeGreaterThanOrEqual(3);
    await expect(
      prisma.enrollmentConsumerAcknowledgement.count(),
    ).resolves.toBe(1);
    await expect(
      prisma.enrollmentConsumerAcknowledgement.findFirst(),
    ).resolves.toMatchObject({ headSequence: 0, headJwsHash: deliveredHash });
  });

  it("serves every concurrent snapshot poll without self-inflicted denial", async () => {
    await clearEnrollmentState();
    configure(k2);
    const user = await prisma.user.create({
      data: {
        username: "cite-concurrency-user",
        email: "cite-concurrency-user@example.test",
      },
    });
    await grantEnrollment({ userId: user.id, expiresAt: futureExpiry() });

    // Seed the steady state that used to make this fail: a backlog of receipts
    // old enough to be prunable. The delivery path previously swept them inside
    // a serializable transaction, so concurrent polls conflicted with each
    // other and the bounded retry turned the losers into 503s. A 503 is a hard
    // deny for the consumer (ADR-034 §4), so contention here denies real users.
    const seed = await getSnapshot(request());
    const seedBody = (await seed.json()) as {
      head_sequence: number;
      head_event_id: string;
      head_event_hash: string;
    };
    await prisma.enrollmentSnapshotDelivery.createMany({
      data: Array.from({ length: 40 }, (_, index) => ({
        consumerId: "axon",
        clientId: "axon-web",
        headSequence: seedBody.head_sequence,
        headEventId: seedBody.head_event_id,
        headEventHash: seedBody.head_event_hash,
        snapshotJwsHash: `concurrency-seed-${index}`,
        deliveredAt: new Date(Date.now() - 600_000),
      })),
    });

    // Well above the 3 the previous test used: a compliant consumer must poll
    // under 90s, and more than one instance may be warm at once, so overlapping
    // polls are the expected shape rather than an exotic case.
    const concurrency = 12;
    const statuses: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const responses = await Promise.all(
        Array.from({ length: concurrency }, () => getSnapshot(request())),
      );
      statuses.push(...responses.map((response) => response.status));
    }
    expect(statuses.filter((status) => status !== 200)).toEqual([]);

    // Polls landing in the same millisecond sign byte-identical statements, so
    // they collapse onto one receipt by unique key — the idempotent outcome,
    // not a lost write. Assert the receipts exist rather than counting them.
    await expect(
      prisma.enrollmentSnapshotDelivery.count({
        where: { deliveredAt: { gt: new Date(Date.now() - 300_000) } },
      }),
    ).resolves.toBeGreaterThan(0);
  });

  it("keeps a receipt acknowledgeable for its full signed budget before pruning", async () => {
    await clearEnrollmentState();
    configure(k2);
    const user = await prisma.user.create({
      data: {
        username: "cite-grace-user",
        email: "cite-grace-user@example.test",
      },
    });
    await grantEnrollment({ userId: user.id, expiresAt: futureExpiry() });

    const response = await getSnapshot(request());
    const body = (await response.json()) as {
      signed_jws: string;
      head_sequence: number;
      head_event_id: string;
      head_event_hash: string;
    };
    const hash = await enrollmentJwsHash(body.signed_jws);

    // Age the receipt to just past its poll budget but inside the skew grace.
    // The consumer's clock may differ from ours by up to the contract's 60s
    // tolerance, so a receipt at this age can still arrive as a legitimate
    // in-budget acknowledgement. Pruning exactly at the budget would lose that
    // race and silently strand the ADR-034 §6 retention proof.
    await prisma.enrollmentSnapshotDelivery.updateMany({
      where: { snapshotJwsHash: hash },
      data: { deliveredAt: new Date(Date.now() - 95_000) },
    });
    await pruneStaleSnapshotReceipts();
    await expect(
      prisma.enrollmentSnapshotDelivery.count({
        where: { snapshotJwsHash: hash },
      }),
    ).resolves.toBe(1);

    // It is still a valid snapshot acknowledgement, which is the property the
    // retention gate depends on.
    await acknowledgeEnrollmentHead({
      headSequence: body.head_sequence,
      headEventId: body.head_event_id,
      headEventHash: body.head_event_hash,
      headJwsHash: hash,
    });
    await expect(
      prisma.enrollmentConsumerAcknowledgement.findFirst(),
    ).resolves.toMatchObject({ lastSnapshotJwsHash: hash });

    // Past the budget AND the grace it is collectable — but the retained
    // recovery receipt is never collected, even when old.
    await prisma.enrollmentSnapshotDelivery.updateMany({
      where: { snapshotJwsHash: hash },
      data: { deliveredAt: new Date(Date.now() - 600_000) },
    });
    await pruneStaleSnapshotReceipts();
    await expect(
      prisma.enrollmentSnapshotDelivery.count({
        where: { snapshotJwsHash: hash },
      }),
    ).resolves.toBe(1);

    // An unretained receipt of the same age IS collected.
    await prisma.enrollmentSnapshotDelivery.create({
      data: {
        consumerId: "axon",
        clientId: "axon-web",
        headSequence: body.head_sequence,
        headEventId: body.head_event_id,
        headEventHash: body.head_event_hash,
        snapshotJwsHash: "grace-unretained",
        deliveredAt: new Date(Date.now() - 600_000),
      },
    });
    await expect(pruneStaleSnapshotReceipts()).resolves.toBe(1);
    await expect(
      prisma.enrollmentSnapshotDelivery.count({
        where: { snapshotJwsHash: "grace-unretained" },
      }),
    ).resolves.toBe(0);
  });
});
