import { afterEach, describe, expect, it } from "vitest";

import { getDnsRecordNames, getStackNames, loadConfig } from "../lib/config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("infrastructure config", () => {
  it("uses the expected rollout defaults", () => {
    const config = loadConfig();

    expect(config.awsProfile).toBe("cortex");
    expect(config.region).toBe("us-west-2");
    expect(config.rootDomain).toBe("ctxhost.com");
    expect(config.deploymentEnvironment).toBe("dev");
    expect(config.instanceType).toBe("t4g.medium");
    expect(config.appVolumeSizeGiB).toBe(50);
    expect(config.dbInstanceClass).toBe("db.t4g.small");
    expect(config.dbAllocatedStorageGiB).toBe(20);
    expect(config.dbBackupRetentionDays).toBe(7);
    expect(config.dbMultiAz).toBe(false);
    expect(config.hostedZoneId).toBeUndefined();

    expect(getStackNames(config)).toEqual({
      network: "cortex-shared-network",
      dns: "cortex-shared-dns",
      app: "cortex-dev-app-host",
      data: "cortex-dev-data",
    });
    expect(getDnsRecordNames(config)).toEqual({
      login: "login.dev.ctxhost.com",
      wildcard: "*.dev.ctxhost.com",
    });
  });

  it("allows environment overrides for deployment-ready values", () => {
    process.env.AWS_PROFILE = "override-profile";
    process.env.AWS_REGION = "us-west-1";
    process.env.ROOT_DOMAIN = "example.com";
    process.env.HOSTED_ZONE_ID = "Z12345";
    process.env.DEPLOY_ENV = "prod";

    const config = loadConfig();

    expect(config.awsProfile).toBe("override-profile");
    expect(config.region).toBe("us-west-1");
    expect(config.rootDomain).toBe("example.com");
    expect(config.hostedZoneId).toBe("Z12345");
    expect(config.deploymentEnvironment).toBe("prod");
    expect(getStackNames(config)).toEqual({
      network: "cortex-shared-network",
      dns: "cortex-shared-dns",
      app: "cortex-prod-app-host",
      data: "cortex-prod-data",
    });
    expect(getDnsRecordNames(config)).toEqual({
      login: "login.example.com",
      wildcard: "*.example.com",
    });
  });
});
