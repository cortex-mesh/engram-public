import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EngramSpikeStack,
  loadSpikeStackConfigFromEnv,
} from "../lib/spike-stack.js";

function fakeOpenNextOutput(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-open-next-"));
  const server = join(root, "server-functions", "default");
  const assets = join(root, "assets", "_next", "static");
  mkdirSync(server, { recursive: true });
  mkdirSync(assets, { recursive: true });
  writeFileSync(
    join(server, "index.mjs"),
    "export const handler = async () => ({ statusCode: 200 });\n",
  );
  writeFileSync(join(assets, "placeholder.txt"), "ok\n");
  return root;
}

describe("EngramSpikeStack", () => {
  it("creates a throwaway OpenNext stack with RDS Proxy and DynamoDB rate limiting", () => {
    const app = new cdk.App();
    const stack = new EngramSpikeStack(app, "SpikeStackTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: {
        vpcId: "vpc-123",
        publicSubnetId: "subnet-public",
        privateSubnetIds: ["subnet-a", "subnet-b"],
        privateRouteTableIds: ["rtb-a", "rtb-b"],
        dbSecurityGroupId: "sg-db",
        dbInstanceIdentifier: "cortex-dev-data-postgres",
        dbEndpointAddress: "cortex-dev-data.example.rds.amazonaws.com",
        dbProxyAuthSecretArn:
          "arn:aws:secretsmanager:us-west-2:123456789012:secret:engram-spike-db-auth-abc123",
        runtimeSecretName: "engram-dev-runtime",
        enrollmentSigningSecretName: "engram-dev-enrollment-signing",
        openNextOutputPath: fakeOpenNextOutput(),
        engramUrl: "https://login.dev.ctxhost.com",
        databaseName: "engram",
        nextPublicDashboardUrl: "https://plexus.dev.ctxhost.com",
        nextPublicSynapseUrl: "https://cortex.dev.ctxhost.com/synapse",
        nextPublicThoughtsUrl: "https://cortex.dev.ctxhost.com/thoughts",
        nextPublicAxonUrl: "https://cortex.dev.ctxhost.com/axon",
        nextPublicPulseUrl: "https://cortex.dev.ctxhost.com/pulse",
        nextPublicGyrusUrl: "https://cortex.dev.ctxhost.com/gyrus",
      },
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::RDS::DBProxy", 1);
    template.resourceCountIs("AWS::EC2::NatGateway", 1);
    template.resourceCountIs("AWS::EC2::Route", 2);
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "rateKey", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({
          ENGRAM_RATE_LIMIT_DYNAMODB_TABLE: {
            Ref: Match.stringLikeRegexp("RateLimitTable"),
          },
          ENGRAM_DEPLOY_ENV: "dev",
          ENGRAM_URL: "https://login.dev.ctxhost.com",
          NEXT_PUBLIC_DASHBOARD_URL: "https://plexus.dev.ctxhost.com",
          NEXT_PUBLIC_SYNAPSE_URL: "https://cortex.dev.ctxhost.com/synapse",
          NEXT_PUBLIC_THOUGHTS_URL: "https://cortex.dev.ctxhost.com/thoughts",
          NEXT_PUBLIC_AXON_URL: "https://cortex.dev.ctxhost.com/axon",
          NEXT_PUBLIC_PULSE_URL: "https://cortex.dev.ctxhost.com/pulse",
          NEXT_PUBLIC_GYRUS_URL: "https://cortex.dev.ctxhost.com/gyrus",
          DATABASE_URL: Match.anyValue(),
        }),
      },
    });
    const functions = template.findResources("AWS::Lambda::Function");
    const serverFunction = Object.values(functions).find(
      (resource) =>
        resource.Properties.Environment?.Variables?.ENGRAM_DEPLOY_ENV === "dev",
    );
    expect(serverFunction).toBeDefined();
    expect(
      JSON.stringify(
        serverFunction!.Properties.Environment.Variables.DATABASE_URL,
      ),
    ).toContain(
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:engram-spike-db-auth-abc123",
    );
    expect(serverFunction!.Properties.Environment.Variables).not.toHaveProperty(
      "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID",
    );
    expect(serverFunction!.Properties.Environment.Variables).toMatchObject({
      ENGRAM_ENROLLMENT_SIGNING_KEY_ID:
        "{{resolve:secretsmanager:engram-dev-enrollment-signing:SecretString:kid}}",
      ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY:
        "{{resolve:secretsmanager:engram-dev-enrollment-signing:SecretString:privateKeyPem}}",
      ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY:
        "{{resolve:secretsmanager:engram-dev-enrollment-signing:SecretString:publicKeyPem}}",
      ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE:
        "{{resolve:secretsmanager:engram-dev-enrollment-signing:SecretString:not_before}}",
      ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER:
        "{{resolve:secretsmanager:engram-dev-enrollment-signing:SecretString:not_after}}",
    });
    template.hasResourceProperties("AWS::RDS::DBProxyTargetGroup", {
      ConnectionPoolConfigurationInfo: {
        ConnectionBorrowTimeout: 30,
        MaxConnectionsPercent: 10,
        MaxIdleConnectionsPercent: 5,
      },
    });
  });

  it("loads spike config from explicit environment variables", () => {
    const previous = { ...process.env };
    process.env.ENGRAM_SPIKE_VPC_ID = "vpc-abc";
    process.env.ENGRAM_SPIKE_PUBLIC_SUBNET_ID = "subnet-public";
    process.env.ENGRAM_SPIKE_PRIVATE_SUBNET_IDS = "subnet-1,subnet-2";
    process.env.ENGRAM_SPIKE_PRIVATE_ROUTE_TABLE_IDS = "rtb-1,rtb-2";
    process.env.ENGRAM_SPIKE_DB_SECURITY_GROUP_ID = "sg-db";
    process.env.ENGRAM_SPIKE_DB_INSTANCE_IDENTIFIER = "db-id";
    process.env.ENGRAM_SPIKE_DB_ENDPOINT_ADDRESS = "db.example";
    process.env.ENGRAM_SPIKE_DB_PROXY_AUTH_SECRET_ARN =
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:db-abc123";
    process.env.ENGRAM_SPIKE_NEXT_PUBLIC_PULSE_URL =
      "https://pulse.override.example";

    try {
      expect(loadSpikeStackConfigFromEnv()).toMatchObject({
        vpcId: "vpc-abc",
        publicSubnetId: "subnet-public",
        privateSubnetIds: ["subnet-1", "subnet-2"],
        privateRouteTableIds: ["rtb-1", "rtb-2"],
        runtimeSecretName: "engram-dev-runtime",
        enrollmentSigningSecretName: "engram-dev-enrollment-signing",
        nextPublicDashboardUrl: "https://plexus.dev.ctxhost.com",
        nextPublicPulseUrl: "https://pulse.override.example",
      });
    } finally {
      process.env = previous;
    }
  });
});
