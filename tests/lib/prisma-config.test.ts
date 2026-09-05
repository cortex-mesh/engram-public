import { describe, expect, it } from "vitest";
import { buildPgPoolConfig } from "@/lib/prisma-config";

// Container deployments (aws-dev, on-prem) must keep node-postgres's default
// pool, so the no-Lambda-marker environment is the baseline for these cases.
const CONTAINER_ENV = {};
const LAMBDA_ENV = { AWS_LAMBDA_FUNCTION_NAME: "engram-prod-web-ServerFunction" };

describe("buildPgPoolConfig pool bounds", () => {
  it("leaves the pool unbounded for long-lived containers", () => {
    const config = buildPgPoolConfig("postgresql://engram:secret@db:5432/engram", CONTAINER_ENV);

    expect(config.max).toBeUndefined();
    expect(config.idleTimeoutMillis).toBeUndefined();
    expect(config.connectionTimeoutMillis).toBeUndefined();
  });

  it("caps the pool under Lambda so concurrency cannot exhaust the instance", () => {
    const config = buildPgPoolConfig("postgresql://engram:secret@db:5432/engram", LAMBDA_ENV);

    expect(config.max).toBe(3);
    expect(config.idleTimeoutMillis).toBe(10_000);
    expect(config.connectionTimeoutMillis).toBe(10_000);
  });

  it("honours an explicit ENGRAM_PG_POOL_MAX override", () => {
    const config = buildPgPoolConfig("postgresql://engram:secret@db:5432/engram", {
      ENGRAM_PG_POOL_MAX: "7",
    });

    expect(config.max).toBe(7);
  });

  it("ignores a non-numeric or non-positive override rather than passing it through", () => {
    for (const bad of ["not-a-number", "0", "-4"]) {
      const config = buildPgPoolConfig("postgresql://engram:secret@db:5432/engram", {
        ENGRAM_PG_POOL_MAX: bad,
        AWS_LAMBDA_FUNCTION_NAME: "fn",
      });

      expect(config.max).toBe(3);
    }
  });

  it("applies bounds even when DATABASE_URL is unset", () => {
    expect(buildPgPoolConfig(undefined, LAMBDA_ENV).max).toBe(3);
  });

  it("applies bounds alongside the stripped-sslmode TLS config", () => {
    const config = buildPgPoolConfig(
      "postgresql://engram:secret@db.example:5432/engram?sslmode=require",
      LAMBDA_ENV,
    );

    expect(config.ssl).toEqual({ rejectUnauthorized: false });
    expect(config.max).toBe(3);
  });
});

describe("buildPgPoolConfig", () => {
  it("passes through database URLs without sslmode=require", () => {
    const databaseUrl = "postgresql://engram:secret@localhost:5432/engram";

    expect(buildPgPoolConfig(databaseUrl)).toEqual({
      connectionString: databaseUrl,
    });
  });

  it("strips sslmode=require and enables unverified TLS for AWS dev RDS", () => {
    const config = buildPgPoolConfig(
      "postgresql://engram:secret@db.example:5432/engram?sslmode=require",
    );

    expect(config.connectionString).toBe(
      "postgresql://engram:secret@db.example:5432/engram",
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("strips sslmode=no-verify and enables unverified TLS for AWS dev RDS", () => {
    const config = buildPgPoolConfig(
      "postgresql://engram:secret@db.example:5432/engram?sslmode=no-verify",
    );

    expect(config.connectionString).toBe(
      "postgresql://engram:secret@db.example:5432/engram",
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("passes through sslmode=disable", () => {
    const databaseUrl =
      "postgresql://engram:secret@localhost:5432/engram?sslmode=disable";

    expect(buildPgPoolConfig(databaseUrl)).toEqual({
      connectionString: databaseUrl,
    });
  });

  it("preserves other query parameters when removing sslmode=require", () => {
    const config = buildPgPoolConfig(
      "postgresql://engram:secret@db.example:5432/engram?application_name=engram&sslmode=require",
    );

    expect(config.connectionString).toBe(
      "postgresql://engram:secret@db.example:5432/engram?application_name=engram",
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });
});
