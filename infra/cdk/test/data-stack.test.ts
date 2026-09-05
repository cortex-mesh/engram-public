import { Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../lib/config.js";
import { DataStack } from "../lib/data-stack.js";
import { CortexNetworkStack } from "../lib/network-stack.js";

describe("data stack", () => {
  it("creates a private shared environment PostgreSQL instance without hardcoding a single app database", () => {
    const app = new cdk.App();
    const config = loadConfig();
    const network = new CortexNetworkStack(app, "NetworkStackForDataTest", { config });
    const stack = new DataStack(app, "DataStackTest", {
      config,
      vpc: network.vpc,
      dbSecurityGroup: network.dbSecurityGroup,
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::RDS::DBInstance", 1);
    template.resourceCountIs("AWS::RDS::DBSubnetGroup", 1);
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);

    template.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      MultiAZ: false,
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DBInstanceClass: "db.t4g.small",
      AllocatedStorage: "20",
      BackupRetentionPeriod: 7,
      MasterUsername: "cortex",
    });

    const subnetGroups = template.findResources("AWS::RDS::DBSubnetGroup");
    expect(Object.keys(subnetGroups)).toHaveLength(1);

    const dbInstances = template.findResources("AWS::RDS::DBInstance");
    const dbValues = Object.values(dbInstances) as Array<{ Properties?: Record<string, unknown> }>;
    expect(dbValues[0]?.Properties?.VPCSecurityGroups).toBeTruthy();
    expect(dbValues[0]?.Properties?.DBName).toBeUndefined();

    const secrets = template.findResources("AWS::SecretsManager::Secret");
    const secretValues = Object.values(secrets) as Array<{
      Properties?: { GenerateSecretString?: { SecretStringTemplate?: string } };
    }>;
    expect(secretValues[0]?.Properties?.GenerateSecretString?.SecretStringTemplate).toContain(
      '"username":"cortex"',
    );
  });
});
