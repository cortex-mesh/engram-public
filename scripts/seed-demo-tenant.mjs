#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import process from "node:process";

import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;

export const DEFAULT_CONFIG = {
  orgName: "Demo",
  orgSlug: "demo",
  ownerEmail: "demo.owner@ctxhost.local",
  ownerUsername: "demo-owner",
  ownerDisplayName: "Demo Owner",
  memberEmail: "demo.member@ctxhost.local",
  memberUsername: "demo-member",
  memberDisplayName: "Demo Member",
  appEntitlements: ["synapse", "thoughts", "pulse", "gyrus", "tradepost"],
  featureEntitlements: [{ appKey: "thoughts", featureKey: "projects" }],
};

// Ally Home Care — aws-dev tenant for the AI family-intake prototype (ADR-019).
// Entitlements: synapse + pulse + thoughts only (no axon/gyrus — not home-care surfaces).
// Feature entitlements intentionally omitted; add thoughts.projects if project boards are needed.
export const ALLY_ORG_CONFIG = {
  orgName: "Ally Home Care",
  orgSlug: "ally",
  ownerEmail: "ally.owner@ctxhost.local",
  ownerUsername: "ally-owner",
  ownerDisplayName: "Ally Owner",
  memberEmail: "ally.member@ctxhost.local",
  memberUsername: "ally-member",
  memberDisplayName: "Ally Member",
  appEntitlements: ["synapse", "pulse", "thoughts"],
  featureEntitlements: [],
};

export function selectTenantPreset(preset) {
  const normalizedPreset = preset?.trim().toLowerCase();
  if (!normalizedPreset || normalizedPreset === "demo") {
    return DEFAULT_CONFIG;
  }
  if (normalizedPreset === "ally") {
    return ALLY_ORG_CONFIG;
  }
  throw new Error(
    `Unknown DEMO_TENANT_PRESET "${preset}". Use "demo" or "ally".`,
  );
}

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
  return value ? ["1", "true", "yes", "on"].includes(value.toLowerCase()) : false;
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

async function findUserByEmail(client, email) {
  const result = await client.query(
    `SELECT "id", "email", "passwordHash" FROM "User" WHERE "email" = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

async function upsertUser(client, user, resetPassword) {
  const existing = await findUserByEmail(client, user.email);
  const shouldSetPassword =
    !existing || resetPassword || Boolean(user.password) || !existing.passwordHash;
  const password = shouldSetPassword
    ? (user.password || generatedPassword())
    : null;
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;

  let result;
  if (existing) {
    result = await client.query(
      `
        UPDATE "User"
        SET "username" = $2,
            "displayName" = $3,
            "emailVerified" = TRUE,
            "role" = 'USER',
            "passwordHash" = COALESCE($4, "passwordHash"),
            "updatedAt" = NOW()
        WHERE "id" = $1
        RETURNING "id", "email", "username", "displayName"
      `,
      [existing.id, user.username, user.displayName, passwordHash],
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

async function upsertFeatureEntitlement(client, orgId, appKey, featureKey) {
  await client.query(
    `
      INSERT INTO "OrgAppFeatureEntitlement" (
        "id", "orgId", "appKey", "featureKey", "enabled", "createdAt", "updatedAt"
      )
      VALUES ($1, $2, $3::"AppKey", $4, TRUE, NOW(), NOW())
      ON CONFLICT ("orgId", "appKey", "featureKey") DO UPDATE
        SET "enabled" = TRUE,
            "updatedAt" = NOW()
    `,
    [randomUUID(), orgId, appKey, featureKey],
  );
}

function readConfig() {
  const preset = selectTenantPreset(process.env.DEMO_TENANT_PRESET);

  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    orgName: optionalEnv("DEMO_ORG_NAME", preset.orgName),
    orgSlug: optionalEnv("DEMO_ORG_SLUG", preset.orgSlug),
    appEntitlements: preset.appEntitlements,
    featureEntitlements: preset.featureEntitlements,
    owner: {
      email: optionalEnv("DEMO_OWNER_EMAIL", preset.ownerEmail).toLowerCase(),
      username: optionalEnv("DEMO_OWNER_USERNAME", preset.ownerUsername),
      displayName: optionalEnv(
        "DEMO_OWNER_DISPLAY_NAME",
        preset.ownerDisplayName,
      ),
      password: process.env.DEMO_OWNER_PASSWORD || null,
    },
    member: {
      email: optionalEnv("DEMO_MEMBER_EMAIL", preset.memberEmail).toLowerCase(),
      username: optionalEnv("DEMO_MEMBER_USERNAME", preset.memberUsername),
      displayName: optionalEnv(
        "DEMO_MEMBER_DISPLAY_NAME",
        preset.memberDisplayName,
      ),
      password: process.env.DEMO_MEMBER_PASSWORD || null,
    },
    resetPasswords: booleanEnv("DEMO_RESET_PASSWORDS"),
    printPasswords: process.env.DEMO_PRINT_PASSWORDS !== "0",
  };
}

function printSummary({ org, owner, member, config }) {
  console.log(`Seeded demo organization: ${org.name} (${org.slug})`);
  console.log(`Tenant URL: https://${org.slug}.dev.ctxhost.com/`);
  console.log(`App entitlements: ${config.appEntitlements.join(", ")}`);
  console.log(
    `Feature entitlements: ${config.featureEntitlements.length > 0
      ? config.featureEntitlements.map((f) => `${f.appKey}/${f.featureKey}`).join(", ")
      : "(none)"}`,
  );
  console.log("");
  console.log(`Owner:  ${owner.email} (${owner.username})`);
  console.log(
    owner.passwordChanged
      ? config.printPasswords
        ? `Owner password: ${owner.password}`
        : "Owner password: set"
      : "Owner password: unchanged",
  );
  console.log(`Member: ${member.email} (${member.username})`);
  console.log(
    member.passwordChanged
      ? config.printPasswords
        ? `Member password: ${member.password}`
        : "Member password: set"
      : "Member password: unchanged",
  );

  if (!config.resetPasswords && (!owner.passwordChanged || !member.passwordChanged)) {
    console.log("");
    console.log("Set DEMO_RESET_PASSWORDS=1 to reset existing fixture passwords.");
  }
}

async function main() {
  const config = readConfig();
  const pool = new Pool(pgPoolConfig(config.databaseUrl));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const org = await upsertOrganization(client, config);
    for (const appKey of config.appEntitlements) {
      await upsertAppEntitlement(client, org.id, appKey);
    }
    for (const feature of config.featureEntitlements) {
      await upsertFeatureEntitlement(client, org.id, feature.appKey, feature.featureKey);
    }

    const owner = await upsertUser(client, config.owner, config.resetPasswords);
    const member = await upsertUser(client, config.member, config.resetPasswords);
    await upsertMembership(client, owner.id, org.id, "OWNER");
    await upsertMembership(client, member.id, org.id, "MEMBER");

    await client.query("COMMIT");
    printSummary({ org, owner, member, config });
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
