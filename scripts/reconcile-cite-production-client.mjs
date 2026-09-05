import pg from "pg";
import {
  CITE_THE_MOVE_CALLBACK,
  CITE_THE_MOVE_CLIENT_ID,
  needsCallbackEnable,
  redirectUrisToRemove,
} from "./cite-production-client-contract.mjs";

export {
  CITE_THE_MOVE_CALLBACK,
  CITE_THE_MOVE_CLIENT_ID,
  needsCallbackEnable,
  redirectUrisToRemove,
};

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  if ([...args].some((arg) => arg !== "--apply")) {
    throw new Error("Usage: npm run reconcile:cite-production-client -- [--apply]");
  }
  if (apply && process.env.ENGRAM_RECONCILE_CONFIRM !== "citethemove-production-client") {
    throw new Error(
      "Refusing to apply. Set ENGRAM_RECONCILE_CONFIRM=citethemove-production-client after human approval.",
    );
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to inspect the native-client registration.");
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const clientResult = await pool.query(
      'SELECT "clientId" FROM "NativeAuthClient" WHERE "clientId" = $1',
      [CITE_THE_MOVE_CLIENT_ID],
    );
    if (clientResult.rowCount !== 1) {
      throw new Error(`Required native client ${CITE_THE_MOVE_CLIENT_ID} was not found; refusing to create it.`);
    }
    const redirectsResult = await pool.query(
      'SELECT "redirectUri", enabled FROM "NativeAuthRedirectUri" WHERE "clientId" = $1',
      [CITE_THE_MOVE_CLIENT_ID],
    );
    const redirectUris = redirectsResult.rows;

    const remove = redirectUrisToRemove(redirectUris);
    const enableCallback = needsCallbackEnable(redirectUris);
    const plan = {
      mode: apply ? "apply" : "dry-run",
      clientId: CITE_THE_MOVE_CLIENT_ID,
      requiredCallback: CITE_THE_MOVE_CALLBACK,
      removeRedirectUris: remove,
      enableRequiredCallback: enableCallback,
    };

    if (!apply || (!enableCallback && remove.length === 0)) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        'DELETE FROM "NativeAuthRedirectUri" WHERE "clientId" = $1 AND "redirectUri" <> $2',
        [CITE_THE_MOVE_CLIENT_ID, CITE_THE_MOVE_CALLBACK],
      );
      await connection.query(
        `INSERT INTO "NativeAuthRedirectUri" (id, "clientId", "redirectUri", enabled, "createdAt", "updatedAt")
         VALUES (concat('native-redirect-cite-prod-', substr(md5(random()::text), 1, 20)), $1, $2, TRUE, NOW(), NOW())
         ON CONFLICT ("clientId", "redirectUri") DO UPDATE SET enabled = TRUE, "updatedAt" = NOW()`,
        [CITE_THE_MOVE_CLIENT_ID, CITE_THE_MOVE_CALLBACK],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    console.log(JSON.stringify({ ...plan, applied: true }, null, 2));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Client reconciliation failed.");
    process.exitCode = 1;
  });
}
