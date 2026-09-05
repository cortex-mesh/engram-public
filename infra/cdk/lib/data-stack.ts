import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

import type { StackPropsWithConfig } from "./types.js";

function normalizeRdsInstanceClass(value: string): string {
  return value.startsWith("db.") ? value.slice(3) : value;
}

export interface DataStackProps extends StackPropsWithConfig {
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
}

export class DataStack extends cdk.Stack {
  readonly database: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.database = new rds.DatabaseInstance(this, "Postgres", {
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [props.dbSecurityGroup],
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_4,
      }),
      instanceType: new ec2.InstanceType(normalizeRdsInstanceClass(props.config.dbInstanceClass)),
      allocatedStorage: props.config.dbAllocatedStorageGiB,
      storageType: rds.StorageType.GP3,
      multiAz: props.config.dbMultiAz,
      publiclyAccessible: false,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(props.config.dbBackupRetentionDays),
      credentials: rds.Credentials.fromGeneratedSecret("cortex"),
      deletionProtection: props.config.deploymentEnvironment === "prod",
      removalPolicy:
        props.config.deploymentEnvironment === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      deleteAutomatedBackups: props.config.deploymentEnvironment !== "prod",
    });
  }
}
