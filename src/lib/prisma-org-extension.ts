import type { PrismaClient } from "@/generated/prisma/client";

export class OrgScopeError extends Error {
  override readonly name = "OrgScopeError";
  constructor(operation: string, model: string) {
    super(
      `[ADR-141] Unscoped ${operation} on ${model} rejected: where.orgId is missing. ` +
        "Include orgId in the where clause, or use prismaUnscoped for intentional cross-org ops.",
    );
  }
}

export function hasOrgScope(where: Record<string, unknown>): boolean {
  if (typeof where.orgId === "string" && where.orgId !== "") return true;
  // Composite keys: orgId_provider, orgId_appKey, orgId_appKey_featureKey (start with orgId_)
  // or userId_orgId, userId_orgId_appKey (exact known patterns — no open-ended substring match
  // which could false-positive on future schema fields).
  return Object.keys(where).some(
    (k) =>
      (k.startsWith("orgId_") || k === "userId_orgId" || k.startsWith("userId_orgId_")) &&
      where[k] != null,
  );
}

function requireOrgScope(
  operation: string,
  model: string,
  where: Record<string, unknown> | undefined,
) {
  if (!where || !hasOrgScope(where)) throw new OrgScopeError(operation, model);
}

function makeGuards(model: string) {
  return {
    async delete({ args, query }: { args: Record<string, unknown>; query: (a: unknown) => unknown }) {
      requireOrgScope("delete", model, args.where as Record<string, unknown> | undefined);
      return query(args);
    },
    async deleteMany({ args, query }: { args: Record<string, unknown>; query: (a: unknown) => unknown }) {
      requireOrgScope("deleteMany", model, args.where as Record<string, unknown> | undefined);
      return query(args);
    },
    async update({ args, query }: { args: Record<string, unknown>; query: (a: unknown) => unknown }) {
      requireOrgScope("update", model, args.where as Record<string, unknown> | undefined);
      return query(args);
    },
    async updateMany({ args, query }: { args: Record<string, unknown>; query: (a: unknown) => unknown }) {
      requireOrgScope("updateMany", model, args.where as Record<string, unknown> | undefined);
      return query(args);
    },
    async updateManyAndReturn({ args, query }: { args: Record<string, unknown>; query: (a: unknown) => unknown }) {
      requireOrgScope("updateManyAndReturn", model, args.where as Record<string, unknown> | undefined);
      return query(args);
    },
    // Upsert: the where clause must include an orgId qualifier. The create.orgId bypass was
    // removed because it allowed the UPDATE arm to fire on a cross-org row. Use prismaUnscoped
    // for true bootstrap/cross-org upsert patterns.
    async upsert({ args, query }: { args: Record<string, unknown>; query: (a: unknown) => unknown }) {
      requireOrgScope("upsert", model, args.where as Record<string, unknown> | undefined);
      return query(args);
    },
  };
}

// Org-scoped models only. Global models (User, RefreshToken, MagicLink, Organization, etc.)
// are intentionally excluded — they are scoped by userId/tokenHash, not orgId.
export function buildOrgExtensionConfig() {
  return {
    query: {
      orgProviderCredential: makeGuards("orgProviderCredential"),
      orgAppEntitlement: makeGuards("orgAppEntitlement"),
      orgAppFeatureEntitlement: makeGuards("orgAppFeatureEntitlement"),
      userAppEntitlement: makeGuards("userAppEntitlement"),
      orgMember: makeGuards("orgMember"),
      orgInvite: makeGuards("orgInvite"),
    },
  };
}

export function buildOrgExtension(basePrisma: PrismaClient) {
  return basePrisma.$extends(buildOrgExtensionConfig());
}
