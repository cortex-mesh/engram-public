type PgSslConfig = { rejectUnauthorized: false };

export interface PgPoolConfig {
  connectionString: string | undefined;
  ssl?: PgSslConfig;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Per-process connection ceiling for aws-prod's Lambda.
 *
 * aws-prod connects straight to RDS (the RDS Proxy that used to bound the
 * fan-in was removed — it cost ~$22/mo to pool a workload that peaked at 9
 * connections). Without a proxy, the ceiling is Lambda concurrency × pool size,
 * and node-postgres defaults to 10 per pool. `db.t4g.micro` allows ~112
 * connections, so the default would let ~11 concurrent containers exhaust the
 * instance — a self-inflicted outage on the auth service under exactly the
 * traffic spike you'd least want one.
 *
 * A Lambda container serves one invocation at a time, so 3 covers a request's
 * parallel queries and interactive transactions with room to spare, and caps
 * the worst case far below the instance limit.
 */
const LAMBDA_POOL_MAX = 3;

/**
 * Long-lived containers (aws-dev, on-prem) serve many concurrent requests from
 * one process and need node-postgres's default pool, so they are deliberately
 * left unbounded here. Returning `undefined` preserves the library default
 * rather than silently shrinking their pool.
 */
/**
 * Only the two keys this module reads, so tests need not build a full
 * ProcessEnv. The index signature keeps `process.env` assignable — without it
 * TypeScript's weak-type check rejects an all-optional target.
 */
export interface PgPoolEnv {
  ENGRAM_PG_POOL_MAX?: string;
  AWS_LAMBDA_FUNCTION_NAME?: string;
  [key: string]: string | undefined;
}

function resolvePoolMax(env: PgPoolEnv): number | undefined {
  const override = env.ENGRAM_PG_POOL_MAX;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return env.AWS_LAMBDA_FUNCTION_NAME ? LAMBDA_POOL_MAX : undefined;
}

function poolBounds(env: PgPoolEnv): Pick<PgPoolConfig, "max" | "idleTimeoutMillis" | "connectionTimeoutMillis"> {
  const max = resolvePoolMax(env);
  if (max === undefined) return {};
  return {
    max,
    // Release idle connections promptly so a burst of warm containers stops
    // holding backend slots once traffic subsides.
    idleTimeoutMillis: 10_000,
    // Fail fast instead of hanging the request if the instance is saturated —
    // a 500 is diagnosable, a stuck Lambda burning its timeout is not.
    connectionTimeoutMillis: 10_000,
  };
}

export function buildPgPoolConfig(
  databaseUrl = process.env.DATABASE_URL,
  env: PgPoolEnv = process.env,
): PgPoolConfig {
  const bounds = poolBounds(env);

  if (!databaseUrl) {
    return { connectionString: databaseUrl, ...bounds };
  }

  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get("sslmode");
  if (!sslMode || sslMode === "disable") {
    return { connectionString: databaseUrl, ...bounds };
  }

  // node-postgres lets sslmode in the connection string override the explicit
  // `ssl` object. Strip AWS-dev TLS flags and pass the TLS config directly.
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    ...bounds,
  };
}
