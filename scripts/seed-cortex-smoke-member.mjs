#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import process from "node:process";

import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;

export const CORTEX_SMOKE_MEMBER_CONFIG = {
  orgName: "CORTEX",
  orgSlug: "cortex",
  email: "cortex.smoke.member@ctxhost.local",
  username: "cortex-smoke-member",
  displayName: "Smoke",
  role: "MEMBER",
};

export const CORTEX_SMOKE_APP_ENTITLEMENTS = ["synapse"];

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function optionalEnv(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function booleanEnv(name) {
  const value = process.env[name];
  return value
    ? ["1", "true", "yes", "on"].includes(value.toLowerCase())
    : false;
}

function generatedPassword() {
  return randomBytes(24).toString("base64url");
}

function pgPoolConfig(databaseUrl) {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get("sslmode");
  if (!sslMode || sslMode === "disable") {
    return { connectionString: databaseUrl };
  }

  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  };
}

async function upsertOrganization(client, config) {
  const result = await client.query(
    `
      INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT ("slug") DO UPDATE
        SET "name" = EXCLUDED."name",
            "updatedAt" = NOW()
      RETURNING "id", "name", "slug"
    `,
    [randomUUID(), config.orgName, config.orgSlug],
  );
  return result.rows[0];
}

async function upsertAppEntitlement(client, orgId, appKey) {
  await client.query(
    `
      INSERT INTO "OrgAppEntitlement" (
        "id", "orgId", "appKey", "enabled", "createdAt", "updatedAt"
      )
      VALUES ($1, $2, $3::"AppKey", TRUE, NOW(), NOW())
      ON CONFLICT ("orgId", "appKey") DO UPDATE
        SET "enabled" = TRUE,
            "updatedAt" = NOW()
    `,
    [randomUUID(), orgId, appKey],
  );
}

async function findUser(client, user) {
  const result = await client.query(
    `
      SELECT "id", "email", "username", "passwordHash"
      FROM "User"
      WHERE "email" = $1 OR "username" = $2
      ORDER BY CASE WHEN "email" = $1 THEN 0 ELSE 1 END
    `,
    [user.email, user.username],
  );
  if (result.rows.length > 1) {
    throw new Error(
      `Refusing to merge distinct users for ${user.email} and ${user.username}.`,
    );
  }
  return result.rows[0] ?? null;
}

async function upsertUser(client, user, resetPassword) {
  const existing = await findUser(client, user);
  const shouldSetPassword =
    !existing ||
    resetPassword ||
    Boolean(user.password) ||
    !existing.passwordHash;
  const password = shouldSetPassword
    ? user.password || generatedPassword()
    : null;
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;

  let result;
  if (existing) {
    result = await client.query(
      `
        UPDATE "User"
        SET "email" = $2,
            "username" = $3,
            "displayName" = $4,
            "emailVerified" = TRUE,
            "role" = 'USER',
            "passwordHash" = COALESCE($5, "passwordHash"),
            "updatedAt" = NOW()
        WHERE "id" = $1
        RETURNING "id", "email", "username", "displayName"
      `,
      [existing.id, user.email, user.username, user.displayName, passwordHash],
    );
  } else {
    result = await client.query(
      `
        INSERT INTO "User" (
          "id", "username", "email", "displayName", "passwordHash",
          "emailVerified", "role", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, TRUE, 'USER', NOW(), NOW())
        RETURNING "id", "email", "username", "displayName"
      `,
      [randomUUID(), user.username, user.email, user.displayName, passwordHash],
    );
  }

  return {
    ...result.rows[0],
    password,
    passwordChanged: Boolean(password),
  };
}

async function upsertMembership(client, userId, orgId, role) {
  await client.query(
    `
      INSERT INTO "OrgMember" ("id", "userId", "orgId", "role", "createdAt")
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT ("userId", "orgId") DO UPDATE
        SET "role" = EXCLUDED."role"
    `,
    [randomUUID(), userId, orgId, role],
  );
}

function readConfig() {
  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    orgName: optionalEnv("CORTEX_ORG_NAME", CORTEX_SMOKE_MEMBER_CONFIG.orgName),
    orgSlug: optionalEnv("CORTEX_ORG_SLUG", CORTEX_SMOKE_MEMBER_CONFIG.orgSlug),
    member: {
      email: optionalEnv(
        "CORTEX_SMOKE_MEMBER_EMAIL",
        CORTEX_SMOKE_MEMBER_CONFIG.email,
      ).toLowerCase(),
      username: optionalEnv(
        "CORTEX_SMOKE_MEMBER_USERNAME",
        CORTEX_SMOKE_MEMBER_CONFIG.username,
      ),
      displayName: optionalEnv(
        "CORTEX_SMOKE_MEMBER_DISPLAY_NAME",
        CORTEX_SMOKE_MEMBER_CONFIG.displayName,
      ),
      password: process.env.CORTEX_SMOKE_MEMBER_PASSWORD || null,
    },
    resetPassword: booleanEnv("CORTEX_SMOKE_MEMBER_RESET_PASSWORD"),
    printPassword: process.env.CORTEX_SMOKE_MEMBER_PRINT_PASSWORD !== "0",
  };
}

function printSummary({ org, member, config }) {
  console.log(
    `Seeded cortex smoke member in organization: ${org.name} (${org.slug})`,
  );
  console.log(`Tenant URL: https://${org.slug}.dev.ctxhost.com/`);
  console.log(
    `App entitlements ensured: ${CORTEX_SMOKE_APP_ENTITLEMENTS.join(", ")}`,
  );
  console.log("");
  console.log(`Member: ${member.email} (${member.username})`);
  console.log(
    member.passwordChanged
      ? config.printPassword
        ? `Member password: ${member.password}`
        : "Member password: set"
      : "Member password: unchanged",
  );
}

async function main() {
  const config = readConfig();
  const pool = new Pool(pgPoolConfig(config.databaseUrl));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const org = await upsertOrganization(client, config);
    for (const appKey of CORTEX_SMOKE_APP_ENTITLEMENTS) {
      await upsertAppEntitlement(client, org.id, appKey);
    }

    const member = await upsertUser(
      client,
      config.member,
      config.resetPassword,
    );
    await upsertMembership(
      client,
      member.id,
      org.id,
      CORTEX_SMOKE_MEMBER_CONFIG.role,
    );

    await client.query("COMMIT");
    printSummary({ org, member, config });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
