// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  buildOrgExtensionConfig,
  OrgScopeError,
  hasOrgScope,
} from "@/lib/prisma-org-extension";

// Drive the extension handler directly via the exposed config object.
async function runHandler(
  cfg: ReturnType<typeof buildOrgExtensionConfig>,
  model: string,
  operation: string,
  args: Record<string, unknown>,
) {
  const queryFn = async (a: Record<string, unknown>) => ({ _query: true, args: a });
  const handler = (
    cfg.query as unknown as Record<
      string,
      Record<string, (ctx: { args: unknown; query: unknown }) => Promise<unknown>>
    >
  )[model][operation];
  const result = await handler({ args, query: queryFn });
  return { args, queryFn, result };
}

describe("hasOrgScope", () => {
  it("accepts direct orgId string field", () => {
    expect(hasOrgScope({ orgId: "org-1" })).toBe(true);
  });

  it("accepts composite key starting with orgId_", () => {
    expect(hasOrgScope({ orgId_provider: { orgId: "org-1", provider: "google" } })).toBe(true);
    expect(hasOrgScope({ orgId_appKey: { orgId: "org-1", appKey: "synapse" } })).toBe(true);
    expect(
      hasOrgScope({
        orgId_appKey_featureKey: { orgId: "org-1", appKey: "synapse", featureKey: "voice" },
      }),
    ).toBe(true);
  });

  it("accepts composite key containing _orgId (userId-first patterns)", () => {
    expect(hasOrgScope({ userId_orgId: { userId: "u1", orgId: "org-1" } })).toBe(true);
    expect(
      hasOrgScope({ userId_orgId_appKey: { userId: "u1", orgId: "org-1", appKey: "synapse" } }),
    ).toBe(true);
  });

  it("rejects where with only non-org fields", () => {
    expect(hasOrgScope({ id: "row-1" })).toBe(false);
    expect(hasOrgScope({})).toBe(false);
    expect(hasOrgScope({ userId: "u1" })).toBe(false);
  });

  it("rejects empty-string orgId", () => {
    expect(hasOrgScope({ orgId: "" })).toBe(false);
  });
});

describe("ADR-141 delete/update guard — D7 regression (incident cannot recur)", () => {
  const cfg = buildOrgExtensionConfig();

  const ORG_SCOPED_MODELS = [
    "orgProviderCredential",
    "orgAppEntitlement",
    "orgAppFeatureEntitlement",
    "userAppEntitlement",
    "orgMember",
    "orgInvite",
  ] as const;

  describe("throws OrgScopeError when orgId is absent from where", () => {
    for (const model of ORG_SCOPED_MODELS) {
      it(`${model}.deleteMany with no where`, async () => {
        await expect(runHandler(cfg, model, "deleteMany", {})).rejects.toThrow(OrgScopeError);
      });

      it(`${model}.deleteMany with where lacking orgId`, async () => {
        await expect(
          runHandler(cfg, model, "deleteMany", { where: { id: "x" } }),
        ).rejects.toThrow(OrgScopeError);
      });

      it(`${model}.delete with where lacking orgId`, async () => {
        await expect(
          runHandler(cfg, model, "delete", { where: { id: "x" } }),
        ).rejects.toThrow(OrgScopeError);
      });

      it(`${model}.updateMany with no where`, async () => {
        await expect(
          runHandler(cfg, model, "updateMany", { data: {} }),
        ).rejects.toThrow(OrgScopeError);
      });

      it(`${model}.update with where lacking orgId`, async () => {
        await expect(
          runHandler(cfg, model, "update", { where: { id: "x" }, data: {} }),
        ).rejects.toThrow(OrgScopeError);
      });

      it(`${model}.updateManyAndReturn with where lacking orgId`, async () => {
        await expect(
          runHandler(cfg, model, "updateManyAndReturn", { where: { id: "x" }, data: {} }),
        ).rejects.toThrow(OrgScopeError);
      });

      it(`${model}.upsert with no org qualifier`, async () => {
        await expect(
          runHandler(cfg, model, "upsert", { where: { id: "x" }, create: {}, update: {} }),
        ).rejects.toThrow(OrgScopeError);
      });
    }
  });

  describe("allows ops when orgId is in the where clause", () => {
    it("orgMember.delete with direct orgId (+ userId)", async () => {
      const { args } = await runHandler(cfg, "orgMember", "delete", {
        where: { id: "mem-1", orgId: "org-1" },
      });
      expect((args.where as Record<string, unknown>).orgId).toBe("org-1");
    });

    it("orgMember.deleteMany with orgId and userId", async () => {
      const { args } = await runHandler(cfg, "orgMember", "deleteMany", {
        where: { orgId: "org-1", userId: "u-1" },
      });
      expect((args.where as Record<string, unknown>).orgId).toBe("org-1");
    });

    it("orgInvite.update with id+orgId (fixed revoke pattern) passes through", async () => {
      const { args } = await runHandler(cfg, "orgInvite", "update", {
        where: { id: "inv-1", orgId: "org-1" },
        data: { revokedAt: new Date() },
      });
      expect((args.where as Record<string, unknown>).orgId).toBe("org-1");
    });

    it("userAppEntitlement.deleteMany with userId+orgId+appKey passes through", async () => {
      const { args } = await runHandler(cfg, "userAppEntitlement", "deleteMany", {
        where: { orgId: "org-1", userId: "u-1", appKey: "synapse" },
      });
      expect((args.where as Record<string, unknown>).orgId).toBe("org-1");
    });

    it("orgAppEntitlement.updateMany with orgId passes through", async () => {
      const { args } = await runHandler(cfg, "orgAppEntitlement", "updateMany", {
        where: { orgId: "org-1", appKey: "synapse" },
        data: { updatedAt: new Date() },
      });
      expect((args.where as Record<string, unknown>).orgId).toBe("org-1");
    });
  });

  describe("allows upserts with composite key containing orgId", () => {
    it("orgProviderCredential.upsert with orgId_provider composite", async () => {
      await expect(
        runHandler(cfg, "orgProviderCredential", "upsert", {
          where: { orgId_provider: { orgId: "org-1", provider: "google" } },
          create: { orgId: "org-1", provider: "google", credentialJson: "{}" },
          update: { credentialJson: "{}" },
        }),
      ).resolves.not.toThrow();
    });

    it("orgAppEntitlement.upsert with orgId_appKey composite", async () => {
      await expect(
        runHandler(cfg, "orgAppEntitlement", "upsert", {
          where: { orgId_appKey: { orgId: "org-1", appKey: "synapse" } },
          create: { orgId: "org-1", appKey: "synapse" },
          update: {},
        }),
      ).resolves.not.toThrow();
    });

    it("orgAppFeatureEntitlement.upsert with orgId_appKey_featureKey composite", async () => {
      await expect(
        runHandler(cfg, "orgAppFeatureEntitlement", "upsert", {
          where: { orgId_appKey_featureKey: { orgId: "org-1", appKey: "synapse", featureKey: "voice" } },
          create: { orgId: "org-1", appKey: "synapse", featureKey: "voice" },
          update: {},
        }),
      ).resolves.not.toThrow();
    });

    it("userAppEntitlement.upsert with userId_orgId_appKey composite", async () => {
      await expect(
        runHandler(cfg, "userAppEntitlement", "upsert", {
          where: { userId_orgId_appKey: { userId: "u-1", orgId: "org-1", appKey: "synapse" } },
          create: { userId: "u-1", orgId: "org-1", appKey: "synapse" },
          update: {},
        }),
      ).resolves.not.toThrow();
    });

    it("orgMember.upsert with userId_orgId composite", async () => {
      await expect(
        runHandler(cfg, "orgMember", "upsert", {
          where: { userId_orgId: { userId: "u-1", orgId: "org-1" } },
          create: { userId: "u-1", orgId: "org-1", role: "MEMBER" },
          update: {},
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("upsert cross-org write is blocked (bootstrap bypass removed)", () => {
    it("orgAppEntitlement.upsert with create.orgId but no where scope throws", async () => {
      // Previously the guard allowed this if create.orgId was set. That opened a cross-org write
      // path: create.orgId="A" + where.id="row-from-B" → guard passes, Prisma updates B's row.
      // Fix: require hasOrgScope(where) always; use prismaUnscoped for true bootstrap cases.
      await expect(
        runHandler(cfg, "orgAppEntitlement", "upsert", {
          where: { id: "ent-1" },
          create: { orgId: "org-1", appKey: "synapse" },
          update: {},
        }),
      ).rejects.toThrow(OrgScopeError);
    });
  });

  describe("OrgScopeError message is informative", () => {
    it("includes model and operation in the message", async () => {
      await expect(
        runHandler(cfg, "orgMember", "deleteMany", {}),
      ).rejects.toThrow("[ADR-141] Unscoped deleteMany on orgMember rejected");
    });

    it("error name is OrgScopeError", async () => {
      let caught: unknown;
      try {
        await runHandler(cfg, "orgInvite", "update", { where: { id: "x" } });
      } catch (e) {
        caught = e;
      }
      expect((caught as { name?: string }).name).toBe("OrgScopeError");
    });

    it("error blocks the old invite-revoke pattern (id-only update)", async () => {
      // The inviteId route previously used { id: inviteId } without orgId — this now throws.
      // The fixed route uses { id: inviteId, orgId } which passes the guard.
      await expect(
        runHandler(cfg, "orgInvite", "update", { where: { id: "inv-1" }, data: { revokedAt: new Date() } }),
      ).rejects.toThrow(OrgScopeError);
    });
  });
});
