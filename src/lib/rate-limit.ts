import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { NextRequest, NextResponse } from "next/server";

// Fixed-window rate limiter for the public auth endpoints (security audit
// 2026-06-10, HG-2). Local/single-host deployments use the in-memory store.
// Lambda/OpenNext deployments set ENGRAM_RATE_LIMIT_DYNAMODB_TABLE so every
// concurrent server instance shares the same counters.
//
// ENGRAM_RATE_LIMIT_DISABLED=1 bypasses all limits (suite tests/scripts).

interface WindowEntry {
  count: number;
  resetAt: number;
}

// Bound memory under a key-spray attack. Eviction is oldest-inserted-first
// (Map iteration order), which is also closest-to-expiry — accepted
// limitation: a sustained >50k-key spray can roll active windows out early.
const MAX_ENTRIES = 50_000;

// globalThis singleton (same pattern as prisma.ts) so dev hot-reload doesn't
// silently reset limiter state, and bundle duplication can't fork it.
const globalStore = globalThis as unknown as {
  __engramRateLimitWindows?: Map<string, WindowEntry>;
  __engramRateLimitDynamoClient?: DynamoSender;
};
const windows = (globalStore.__engramRateLimitWindows ??= new Map());

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const ALLOWED: RateLimitResult = { allowed: true, retryAfterSeconds: 0 };

type DynamoSender = {
  send(command: unknown): Promise<unknown>;
};

let dynamoClientForTests: DynamoSender | undefined;

function isDisabled(): boolean {
  return process.env.ENGRAM_RATE_LIMIT_DISABLED === "1";
}

function dynamoTableName(): string | undefined {
  return process.env.ENGRAM_RATE_LIMIT_DYNAMODB_TABLE?.trim() || undefined;
}

function dynamoClient(): DynamoSender {
  if (dynamoClientForTests) return dynamoClientForTests;
  if (globalStore.__engramRateLimitDynamoClient) return globalStore.__engramRateLimitDynamoClient;
  const config: DynamoDBClientConfig = {};
  if (process.env.AWS_REGION) config.region = process.env.AWS_REGION;
  return (globalStore.__engramRateLimitDynamoClient = new DynamoDBClient(config));
}

function keyAttribute(key: string): { S: string } {
  return { S: key };
}

function numberAttribute(value: number): { N: string } {
  return { N: String(value) };
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}

function blocked(entry: WindowEntry, now: number): RateLimitResult {
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

function setWindow(key: string, windowMs: number, now: number): void {
  // Only evict when inserting a NEW key — overwriting an existing (expired)
  // key doesn't grow the map. O(1): oldest-inserted is closest to expiry.
  if (!windows.has(key) && windows.size >= MAX_ENTRIES) {
    const oldest = windows.keys().next().value;
    if (oldest !== undefined) windows.delete(oldest);
  }
  windows.set(key, { count: 1, resetAt: now + windowMs });
}

async function getDynamoEntry(tableName: string, key: string): Promise<WindowEntry | undefined> {
  const result = (await dynamoClient().send(
    new GetItemCommand({
      TableName: tableName,
      Key: { rateKey: keyAttribute(key) },
      ConsistentRead: true,
    }),
  )) as { Item?: { count?: { N?: string }; resetAt?: { N?: string } } };

  const count = Number(result.Item?.count?.N);
  const resetAt = Number(result.Item?.resetAt?.N);
  if (!Number.isFinite(count) || !Number.isFinite(resetAt)) return undefined;
  return { count, resetAt };
}

async function startDynamoWindow(
  tableName: string,
  key: string,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const resetAt = now + windowMs;
  try {
    await dynamoClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          rateKey: keyAttribute(key),
          count: numberAttribute(1),
          resetAt: numberAttribute(resetAt),
          ttl: numberAttribute(Math.ceil(resetAt / 1000)),
        },
        ConditionExpression: "attribute_not_exists(rateKey) OR #resetAt <= :now",
        ExpressionAttributeNames: { "#resetAt": "resetAt" },
        ExpressionAttributeValues: { ":now": numberAttribute(now) },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

async function incrementActiveDynamoWindow(
  tableName: string,
  key: string,
  now: number,
): Promise<WindowEntry | undefined> {
  try {
    const result = (await dynamoClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { rateKey: keyAttribute(key) },
        ConditionExpression: "#resetAt > :now",
        UpdateExpression: "ADD #count :one",
        ExpressionAttributeNames: { "#count": "count", "#resetAt": "resetAt" },
        ExpressionAttributeValues: { ":one": numberAttribute(1), ":now": numberAttribute(now) },
        ReturnValues: "ALL_NEW",
      }),
    )) as { Attributes?: { count?: { N?: string }; resetAt?: { N?: string } } };

    const count = Number(result.Attributes?.count?.N);
    const resetAt = Number(result.Attributes?.resetAt?.N);
    if (!Number.isFinite(count) || !Number.isFinite(resetAt)) return undefined;
    return { count, resetAt };
  } catch (error) {
    if (isConditionalCheckFailed(error)) return undefined;
    throw error;
  }
}

// Count this request against the window and report whether it exceeded the
// limit. Use for plain request-rate limits (every request counts).
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (isDisabled()) return ALLOWED;
  const now = Date.now();
  const tableName = dynamoTableName();
  if (tableName) {
    const entry = await incrementActiveDynamoWindow(tableName, key, now);
    if (!entry) {
      if (await startDynamoWindow(tableName, key, windowMs, now)) return ALLOWED;
      const retryEntry = await incrementActiveDynamoWindow(tableName, key, now);
      if (!retryEntry) return ALLOWED;
      return retryEntry.count > limit ? blocked(retryEntry, now) : ALLOWED;
    }
    if (entry.count > limit) return blocked(entry, now);
    return ALLOWED;
  }

  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    setWindow(key, windowMs, now);
    return ALLOWED;
  }
  entry.count += 1;
  return entry.count > limit ? blocked(entry, now) : ALLOWED;
}

// Peek without counting. Use with recordRateLimitHit for failure-based
// limits (only failed attempts count, but blocked callers are rejected
// before doing any work).
export async function checkRateLimit(key: string, limit: number): Promise<RateLimitResult> {
  if (isDisabled()) return ALLOWED;
  const now = Date.now();
  const tableName = dynamoTableName();
  if (tableName) {
    const entry = await getDynamoEntry(tableName, key);
    if (!entry || entry.resetAt <= now || entry.count < limit) return ALLOWED;
    return blocked(entry, now);
  }

  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now || entry.count < limit) return ALLOWED;
  return blocked(entry, now);
}

export async function recordRateLimitHit(key: string, windowMs: number): Promise<void> {
  if (isDisabled()) return;
  const now = Date.now();
  const tableName = dynamoTableName();
  if (tableName) {
    const entry = await incrementActiveDynamoWindow(tableName, key, now);
    if (!entry) {
      if (await startDynamoWindow(tableName, key, windowMs, now)) return;
      await incrementActiveDynamoWindow(tableName, key, now);
      return;
    }
    return;
  }

  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    setWindow(key, windowMs, now);
    return;
  }
  entry.count += 1;
}

// e.g. clear an account's failure counter after a successful login
export async function clearRateLimit(key: string): Promise<void> {
  if (isDisabled()) return;
  const tableName = dynamoTableName();
  if (tableName) {
    await dynamoClient().send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: { rateKey: keyAttribute(key) },
      }),
    );
    return;
  }
  windows.delete(key);
}

// Client IP for rate-limit keys. Engram always sits behind Caddy, which
// APPENDS the real client address to X-Forwarded-For — so only the LAST
// entry is trustworthy; earlier entries are client-supplied and spoofable.
export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function rateLimitResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) },
    },
  );
}

export function _resetRateLimitForTests(): void {
  windows.clear();
  dynamoClientForTests = undefined;
  globalStore.__engramRateLimitDynamoClient = undefined;
}

export function _setRateLimitDynamoClientForTests(client: DynamoSender): void {
  dynamoClientForTests = client;
}
