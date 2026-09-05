import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildPgPoolConfig } from "@/lib/prisma-config";
import { buildOrgExtension } from "@/lib/prisma-org-extension";

const globalForPrisma = globalThis as unknown as {
  basePrisma: PrismaClient;
};

function createBasePrismaClient() {
  const poolConfig = buildPgPoolConfig();
  const adapter = new PrismaPg(poolConfig);
  return new PrismaClient({ adapter });
}

// Not exported — internal only. Use prismaUnscoped for intentional bypass.
// basePrisma is cached to reuse the connection pool across hot-reloads.
// The guard extension is NOT cached — always re-applied so hot-reloads pick up the current guard.
const basePrisma: PrismaClient = globalForPrisma.basePrisma ?? createBasePrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.basePrisma = basePrisma;

export const prisma = buildOrgExtension(basePrisma);
export const prismaUnscoped = basePrisma;
