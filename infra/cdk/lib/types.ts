import type { StackProps } from "aws-cdk-lib";

export interface InfraConfig {
  awsProfile: string;
  region: string;
  rootDomain: string;
  hostedZoneId?: string;
  deploymentEnvironment: "dev" | "prod";
  instanceType: string;
  appVolumeSizeGiB: number;
  dbInstanceClass: string;
  dbAllocatedStorageGiB: number;
  dbBackupRetentionDays: number;
  dbMultiAz: boolean;
}

export interface StackPropsWithConfig extends StackProps {
  config: InfraConfig;
}
