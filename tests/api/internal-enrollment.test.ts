import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { NextRequest } from "next/server";

import { mockPrisma } from "../mocks/prisma";
import { GET as getEvents } from "@/app/api/internal/enrollment/v1/events/route";
import { GET as getKeys } from "@/app/api/internal/enrollment/v1/keys/route";
import { GET as getSnapshot } from "@/app/api/internal/enrollment/v1/snapshot/route";
import { POST as acknowledge } from "@/app/api/internal/enrollment/v1/acknowledgements/route";

const ORIGINAL_ENV = { ...process.env };
const EVENT = {
  id: "event-1",
  sequence: 1,
  eventHash: "a".repeat(43),
  signedJws: "header.payload.signature",
};

function request(
  path: string,
  init: { method?: string; body?: BodyInit; headers?: HeadersInit } = {},
) {
  return new NextRequest(`https://login.dev.ctxhost.com${path}`, {
    method: init.method,
    body: init.body,
    headers: { Authorization: "Bearer axon-test-key", ...(init.headers || {}) },
  });
}

describe("Cite enrollment internal consumer path", () => {
  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    process.env.ENGRAM_AXON_ENROLLMENT_API_KEY = "axon-test-key";
    process.env.ENGRAM_ENROLLMENT_SIGNING_KEY_ID = "cite-key-2026";
    process.env.ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY =
      await exportPKCS8(privateKey);
    process.env.ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY =
      await exportSPKI(publicKey);
    process.env.ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE =
      "2026-01-01T00:00:00.000Z";
    process.env.ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER =
      "2027-01-01T00:00:00.000Z";
  });

  afterAll(() => {
    vi.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER =
      "2027-01-01T00:00:00.000Z";
    for (const model of Object.values(mockPrisma)) {
      for (const fn of Object.values(model))
        (fn as ReturnType<typeof vi.fn>).mockReset?.();
    }
    mockPrisma.enrollmentConsumerDelivery.upsert.mockResolvedValue({});
  });

  it("publishes only a scoped RS256 public key and rejects an unknown consumer key", async () => {
    const response = await getKeys(request("/api/internal/enrollment/v1/keys"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contract_version: 1,
      keys: [
        { kid: "cite-key-2026", alg: "RS256", use: "sig", status: "active" },
      ],
    });

    const rejected = await getKeys(
      new NextRequest(
        "https://login.dev.ctxhost.com/api/internal/enrollment/v1/keys",
        { headers: { Authorization: "Bearer wrong-key" } },
      ),
    );
    expect(rejected.status).toBe(401);
  });

  it("accepts the dedicated consumer credential when deployment configuration adds whitespace", async () => {
    process.env.ENGRAM_AXON_ENROLLMENT_API_KEY = "  axon-test-key  ";
    try {
      const response = await getKeys(
        request("/api/internal/enrollment/v1/keys"),
      );
      expect(response.status).toBe(200);
    } finally {
      process.env.ENGRAM_AXON_ENROLLMENT_API_KEY = "axon-test-key";
    }
  });

  it("does not disclose a signed snapshot without the dedicated consumer credential", async () => {
    const response = await getSnapshot(
      new NextRequest(
        "https://login.dev.ctxhost.com/api/internal/enrollment/v1/snapshot",
      ),
    );
    expect(response.status).toBe(401);
    expect(mockPrisma.enrollmentStream.findUnique).not.toHaveBeenCalled();
  });

  it("does not mutate the acknowledgement cursor without the dedicated consumer credential", async () => {
    const response = await acknowledge(
      new NextRequest(
        "https://login.dev.ctxhost.com/api/internal/enrollment/v1/acknowledgements",
        {
          method: "POST",
          body: JSON.stringify({
            contract_version: 1,
            head_sequence: 0,
            head_event_id: null,
            head_event_hash: null,
            head_jws_hash: "a".repeat(43),
          }),
        },
      ),
    );
    expect(response.status).toBe(401);
    expect(
      mockPrisma.enrollmentConsumerAcknowledgement.create,
    ).not.toHaveBeenCalled();
  });

  it("keeps public verification material available after the signing window expires", async () => {
    process.env.ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER =
      "2020-01-01T00:00:00.000Z";
    const response = await getKeys(request("/api/internal/enrollment/v1/keys"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      keys: [{ kid: "cite-key-2026", status: "active" }],
    });
  });

  it("does not allow another client to read Axon enrollment state", async () => {
    const response = await getEvents(
      request(
        "/api/internal/enrollment/v1/events?after_sequence=0&client_id=tradepost-web",
      ),
    );
    expect(response.status).toBe(403);
    expect(mockPrisma.enrollmentEvent.findMany).not.toHaveBeenCalled();
  });

  it("mutation-guards retained cursor recovery and caps a page at its captured head", async () => {
    mockPrisma.enrollmentStream.findUnique.mockResolvedValue({
      headSequence: 1,
      retainedFrom: 1,
    });
    mockPrisma.enrollmentEvent.findMany.mockResolvedValue([EVENT]);
    const page = await getEvents(
      request("/api/internal/enrollment/v1/events?after_sequence=0"),
    );
    expect(page.status).toBe(200);
    expect(mockPrisma.enrollmentEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sequence: { gt: 0, lte: 1 } }),
      }),
    );

    mockPrisma.enrollmentStream.findUnique.mockResolvedValue({
      headSequence: 5,
      retainedFrom: 3,
    });
    const expired = await getEvents(
      request("/api/internal/enrollment/v1/events?after_sequence=0"),
    );
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "CURSOR_EXPIRED", retryable: true },
    });
  });

  it("delivers a contiguous event and accepts an acknowledgement only after that delivery", async () => {
    mockPrisma.enrollmentStream.findUnique.mockResolvedValue({
      headSequence: 1,
    });
    mockPrisma.enrollmentEvent.findMany.mockResolvedValue([EVENT]);
    const events = await getEvents(
      request("/api/internal/enrollment/v1/events?after_sequence=0"),
    );
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      after_sequence: 0,
      head_sequence: 1,
      events: [
        { sequence: 1, event_id: "event-1", event_hash: "a".repeat(43) },
      ],
    });
    expect(mockPrisma.enrollmentConsumerDelivery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          consumerId: "axon",
          clientId: "axon-web",
          sequence: 1,
        }),
      }),
    );

    mockPrisma.enrollmentConsumerAcknowledgement.findUnique.mockResolvedValue(
      null,
    );
    mockPrisma.enrollmentConsumerDelivery.findUnique.mockResolvedValue({
      eventId: "event-1",
      eventHash: "a".repeat(43),
    });
    mockPrisma.enrollmentConsumerAcknowledgement.create.mockResolvedValue({
      headSequence: 1,
      headEventId: "event-1",
      headEventHash: "a".repeat(43),
      headJwsHash: "a".repeat(43),
      acknowledgedAt: new Date("2026-07-29T00:00:00.000Z"),
    });
    const ack = await acknowledge(
      request("/api/internal/enrollment/v1/acknowledgements", {
        method: "POST",
        body: JSON.stringify({
          contract_version: 1,
          head_sequence: 1,
          head_event_id: "event-1",
          head_event_hash: "a".repeat(43),
          head_jws_hash: "a".repeat(43),
        }),
      }),
    );
    expect(ack.status).toBe(200);
    await expect(ack.json()).resolves.toMatchObject({
      status: "acknowledged",
      head_sequence: 1,
    });
  });

  it("fails closed instead of acknowledging an undelivered or mismatched event", async () => {
    mockPrisma.enrollmentConsumerAcknowledgement.findUnique.mockResolvedValue(
      null,
    );
    mockPrisma.enrollmentConsumerDelivery.findUnique.mockResolvedValue(null);
    const response = await acknowledge(
      request("/api/internal/enrollment/v1/acknowledgements", {
        method: "POST",
        body: JSON.stringify({
          contract_version: 1,
          head_sequence: 1,
          head_event_id: "undelivered",
          head_event_hash: "b".repeat(43),
          head_jws_hash: "b".repeat(43),
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(
      mockPrisma.enrollmentConsumerAcknowledgement.upsert,
    ).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", '"ack"', "42", "{"])(
    "mutation-guards malformed acknowledgement body %s",
    async (body) => {
      const response = await acknowledge(
        request("/api/internal/enrollment/v1/acknowledgements", {
          method: "POST",
          body,
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "ACKNOWLEDGEMENT_INVALID" },
      });
      expect(
        mockPrisma.enrollmentConsumerAcknowledgement.create,
      ).not.toHaveBeenCalled();
    },
  );

  it("mutation-guards same-head retries by binding the persisted JWS hash", async () => {
    mockPrisma.enrollmentConsumerAcknowledgement.findUnique.mockResolvedValue({
      headSequence: 1,
      headEventId: "event-1",
      headEventHash: "a".repeat(43),
      headJwsHash: "a".repeat(43),
    });
    const response = await acknowledge(
      request("/api/internal/enrollment/v1/acknowledgements", {
        method: "POST",
        body: JSON.stringify({
          contract_version: 1,
          head_sequence: 1,
          head_event_id: "event-1",
          head_event_hash: "a".repeat(43),
          head_jws_hash: "b".repeat(43),
        }),
      }),
    );
    expect(response.status).toBe(409);
  });
});
