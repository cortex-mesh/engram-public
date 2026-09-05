import type { InfraConfig } from "./types.js";

const DEFAULT_CONFIG: InfraConfig = {
  awsProfile: "cortex",
  region: "us-west-2",
  rootDomain: "ctxhost.com",
  hostedZoneId: undefined,
  deploymentEnvironment: "dev",
  instanceType: "t4g.medium",
  appVolumeSizeGiB: 50,
  dbInstanceClass: "db.t4g.small",
  dbAllocatedStorageGiB: 20,
  dbBackupRetentionDays: 7,
  dbMultiAz: false,
};

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function envBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  return undefined;
}

function envDeploymentEnvironment(): InfraConfig["deploymentEnvironment"] | undefined {
  const raw = process.env.DEPLOY_ENV?.toLowerCase();
  if (raw === "dev" || raw === "prod") {
    return raw;
  }
  return undefined;
}

export function loadConfig(overrides: Partial<InfraConfig> = {}): InfraConfig {
  return {
    ...DEFAULT_CONFIG,
    awsProfile: process.env.AWS_PROFILE || DEFAULT_CONFIG.awsProfile,
    region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || DEFAULT_CONFIG.region,
    rootDomain: process.env.ROOT_DOMAIN || DEFAULT_CONFIG.rootDomain,
    hostedZoneId: process.env.HOSTED_ZONE_ID || DEFAULT_CONFIG.hostedZoneId,
    deploymentEnvironment: envDeploymentEnvironment() || DEFAULT_CONFIG.deploymentEnvironment,
    instanceType: process.env.INSTANCE_TYPE || DEFAULT_CONFIG.instanceType,
    appVolumeSizeGiB: envNumber("APP_VOLUME_SIZE_GIB") || DEFAULT_CONFIG.appVolumeSizeGiB,
    dbInstanceClass: process.env.DB_INSTANCE_CLASS || DEFAULT_CONFIG.dbInstanceClass,
    dbAllocatedStorageGiB:
      envNumber("DB_ALLOCATED_STORAGE_GIB") || DEFAULT_CONFIG.dbAllocatedStorageGiB,
    dbBackupRetentionDays:
      envNumber("DB_BACKUP_RETENTION_DAYS") || DEFAULT_CONFIG.dbBackupRetentionDays,
    dbMultiAz: envBoolean("DB_MULTI_AZ") ?? DEFAULT_CONFIG.dbMultiAz,
    ...overrides,
  };
}

export function getStackNames(config: InfraConfig): {
  network: string;
  dns: string;
  app: string;
  data: string;
} {
  return {
    network: "cortex-shared-network",
    dns: "cortex-shared-dns",
    app: `cortex-${config.deploymentEnvironment}-app-host`,
    data: `cortex-${config.deploymentEnvironment}-data`,
  };
}

export function getDnsRecordNames(config: InfraConfig): {
  login: string;
  wildcard: string;
} {
  if (config.deploymentEnvironment === "prod") {
    return {
      login: `login.${config.rootDomain}`,
      wildcard: `*.${config.rootDomain}`,
    };
  }

  return {
    login: `login.dev.${config.rootDomain}`,
    wildcard: `*.dev.${config.rootDomain}`,
  };
}

export function getSharedDnsRecordNames(config: InfraConfig): {
  devLogin: string;
  devWildcard: string;
  prodLogin: string;
  prodWildcard: string;
} {
  return {
    devLogin: `login.dev.${config.rootDomain}`,
    devWildcard: `*.dev.${config.rootDomain}`,
    prodLogin: `login.${config.rootDomain}`,
    prodWildcard: `*.${config.rootDomain}`,
  };
}
