import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  addEngramProdStacks,
  EngramProdCertStack,
  EngramProdDataStack,
  EngramProdOpsStack,
  EngramProdWebStack,
  hasProdWebInputs,
  loadProdStackConfigFromEnv,
  type ProdStackConfig,
} from "../lib/prod-stacks.js";

function fakeOpenNextOutput(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-prod-open-next-"));
  const server = join(root, "server-functions", "default");
  const assets = join(root, "assets", "_next", "static");
  mkdirSync(server, { recursive: true });
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(server, "index.mjs"), "export const handler = async () => ({ statusCode: 200 });\n");
  writeFileSync(join(assets, "placeholder.txt"), "ok\n");
  return root;
}

function config(overrides: Partial<ProdStackConfig> = {}): ProdStackConfig {
  return {
    hostedZoneId: "ZCTXHOST",
    hostedZoneName: "ctxhost.com",
    certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/prod-cert",
    webAclArn:
      "arn:aws:wafv2:us-east-1:123456789012:global/webacl/engram-prod/00000000-0000-0000-0000-000000000000",
    openNextOutputPath: fakeOpenNextOutput(),
    databaseName: "engram",
    dbInstanceClass: "t4g.micro",
    dbAllocatedStorageGiB: 20,
    monthlyBudgetUsd: 110,
    alertEmail: "ops@example.com",
    engramUrl: "https://login.ctxhost.com",
    platformUrl: "https://platform.ctxhost.com",
    tradepostUrl: "https://ccgtradepost.com",
    secretPrefix: "cortex/prod/engram",
    ...overrides,
  };
}

const PROD_CONFIG_ENV = [
  "ENGRAM_PROD_HOSTED_ZONE_ID",
  "ENGRAM_PROD_CERTIFICATE_ARN",
  "ENGRAM_PROD_WEB_ACL_ARN",
  "ENGRAM_PROD_OPEN_NEXT_OUTPUT_PATH",
] as const;

function withProdConfigEnv(overrides: Partial<Record<(typeof PROD_CONFIG_ENV)[number], string>>, run: () => void) {
  const previous = new Map(PROD_CONFIG_ENV.map((name) => [name, process.env[name]]));
  const values = {
    ENGRAM_PROD_HOSTED_ZONE_ID: "ZCTXHOST",
    ENGRAM_PROD_CERTIFICATE_ARN: "arn:aws:acm:us-east-1:123456789012:certificate/prod-cert",
    ENGRAM_PROD_WEB_ACL_ARN:
      "arn:aws:wafv2:us-east-1:123456789012:global/webacl/engram-prod/00000000-0000-0000-0000-000000000000",
    ENGRAM_PROD_OPEN_NEXT_OUTPUT_PATH: fakeOpenNextOutput(),
    ...overrides,
  };

  try {
    for (const name of PROD_CONFIG_ENV) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    run();
  } finally {
    for (const name of PROD_CONFIG_ENV) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function synthProdWebFromEnv() {
  const app = new cdk.App();
  const prodConfig = loadProdStackConfigFromEnv();
  const data = new EngramProdDataStack(app, "DataForEnvTest", {
    env: { account: "123456789012", region: "us-west-2" },
    config: prodConfig,
  });
  const web = new EngramProdWebStack(app, "WebFromEnvTest", {
    env: { account: "123456789012", region: "us-west-2" },
    config: prodConfig,
    vpc: data.vpc,
    lambdaSecurityGroup: data.lambdaSecurityGroup,
    databaseSecret: data.database.secret!,
    databaseEndpoint: data.database.instanceEndpoint.hostname,
    rateLimitTable: data.rateLimitTable,
  });
  Template.fromStack(web);
}

describe("Engram prod stacks", () => {
  it("stamps cost-allocation tags on prod resources so spend is attributable", () => {
    // Without app/env, engram lands in Cost Explorer's untagged bucket and has
    // to be split by hand from usage types — how the 2026-08-14 baseline was
    // built. Tagged per stack, not App-wide: this repo also declares the
    // cortex-* stacks it does not own.
    const app = new cdk.App();
    const prodConfig = config();
    addEngramProdStacks(app, prodConfig, { account: "123456789012", region: "us-west-2" });
    const data = app.node.findChild("engram-prod-data") as EngramProdDataStack;

    const tags = Template.fromStack(data)
      .findResources("AWS::RDS::DBInstance");
    const dbTags = Object.values(tags)[0]?.Properties?.Tags ?? [];
    const byKey = Object.fromEntries(dbTags.map((t: { Key: string; Value: string }) => [t.Key, t.Value]));

    expect(byKey.app).toBe("engram");
    expect(byKey.env).toBe("prod");
    expect(byKey.repo).toBe("cortex-mesh/engram");
    expect(byKey["managed-by"]).toBe("cdk");
  });

  it("lets the Lambda reach Postgres directly, so DATABASE_URL can leave the RDS Proxy", () => {
    const app = new cdk.App();
    const data = new EngramProdDataStack(app, "DataDirectDbTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
    });
    const template = Template.fromStack(data);

    // The ingress rule lives in the data stack precisely so it exists before
    // the web stack repoints DATABASE_URL; CDK deploys data before web.
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      FromPort: 5432,
      ToPort: 5432,
      Description: "Postgres direct from Lambda",
      GroupId: { "Fn::GetAtt": [Match.stringLikeRegexp("DatabaseSecurityGroup"), "GroupId"] },
      SourceSecurityGroupId: { "Fn::GetAtt": [Match.stringLikeRegexp("LambdaSecurityGroup"), "GroupId"] },
    });
  });

  it("points DATABASE_URL at the RDS instance rather than the proxy endpoint", () => {
    const app = new cdk.App();
    const data = new EngramProdDataStack(app, "DataUrlTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
    });
    const web = new EngramProdWebStack(app, "WebUrlTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
      vpc: data.vpc,
      lambdaSecurityGroup: data.lambdaSecurityGroup,
      databaseSecret: data.database.secret!,
      databaseEndpoint: data.database.instanceEndpoint.hostname,
      rateLimitTable: data.rateLimitTable,
    });

    const functions = Template.fromStack(web).findResources("AWS::Lambda::Function");
    const urls = Object.values(functions)
      .map((fn) => fn.Properties?.Environment?.Variables?.DATABASE_URL)
      .filter(Boolean)
      .map((url) => JSON.stringify(url));

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      // Resolves to the Postgres instance's own endpoint, never the proxy's.
      expect(url).toMatch(/Postgres\w*EndpointAddress/);
      expect(url).not.toMatch(/RdsProxy/i);
    }
  });

  it("allows cert, data, and ops synthesis when the workflow supplies empty certificate and WebACL inputs", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      withProdConfigEnv(
        { ENGRAM_PROD_CERTIFICATE_ARN: "", ENGRAM_PROD_WEB_ACL_ARN: "" },
        () => {
        const app = new cdk.App();
        const prodConfig = loadProdStackConfigFromEnv();
        addEngramProdStacks(app, prodConfig, { account: "123456789012", region: "us-west-2" });
        const stack = app.node.findChild("engram-prod-cert") as EngramProdCertStack;
        const data = app.node.findChild("engram-prod-data") as EngramProdDataStack;
        const ops = app.node.findChild("engram-prod-ops") as EngramProdOpsStack;

        expect(hasProdWebInputs(prodConfig)).toBe(false);
        expect(app.node.tryFindChild("engram-prod-data")).toBeDefined();
        expect(app.node.tryFindChild("engram-prod-web")).toBeUndefined();
        expect(() => Template.fromStack(stack)).not.toThrow();
        expect(() => Template.fromStack(data)).not.toThrow();
        expect(() => Template.fromStack(ops)).not.toThrow();
        },
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("ENGRAM_PROD_CERTIFICATE_ARN and ENGRAM_PROD_WEB_ACL_ARN are empty or unavailable"),
      );
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("omitting engram-prod-web"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("synthesizes data and ops when no certificate or WebACL inputs exist", () => {
    withProdConfigEnv(
      { ENGRAM_PROD_CERTIFICATE_ARN: undefined, ENGRAM_PROD_WEB_ACL_ARN: undefined },
      () => {
        const app = new cdk.App();
        const prodConfig = loadProdStackConfigFromEnv();
        addEngramProdStacks(app, prodConfig, { account: "123456789012", region: "us-west-2" });

        expect(app.node.tryFindChild("engram-prod-data")).toBeDefined();
        expect(app.node.tryFindChild("engram-prod-web")).toBeUndefined();
        expect(() => Template.fromStack(app.node.findChild("engram-prod-data") as EngramProdDataStack)).not.toThrow();
        expect(() => Template.fromStack(app.node.findChild("engram-prod-ops") as EngramProdOpsStack)).not.toThrow();
      },
    );
  });

  it("uses the supplied config, rather than process.env, to decide whether to add web consumers", () => {
    withProdConfigEnv(
      { ENGRAM_PROD_CERTIFICATE_ARN: "", ENGRAM_PROD_WEB_ACL_ARN: "" },
      () => {
        const app = new cdk.App();
        addEngramProdStacks(app, config(), { account: "123456789012", region: "us-west-2" });

        expect(app.node.tryFindChild("engram-prod-data")).toBeDefined();
        expect(app.node.tryFindChild("engram-prod-web")).toBeDefined();
      },
    );
  });

  it.each([
    ["ENGRAM_PROD_CERTIFICATE_ARN", undefined],
    ["ENGRAM_PROD_CERTIFICATE_ARN", "None"],
    ["ENGRAM_PROD_CERTIFICATE_ARN", ""],
    ["ENGRAM_PROD_WEB_ACL_ARN", undefined],
    ["ENGRAM_PROD_WEB_ACL_ARN", "None"],
    ["ENGRAM_PROD_WEB_ACL_ARN", ""],
  ] as const)("rejects %s=%s instead of synthesizing engram-prod-web with a placeholder", (name, value) => {
    withProdConfigEnv({ [name]: value }, () => {
      expect(synthProdWebFromEnv).toThrow(`${name} is required when synthesizing engram-prod-web`);
    });
  });

  it("creates the prod cert stack for suite and branded auth hostnames", () => {
    const app = new cdk.App();
    const stack = new EngramProdCertStack(app, "CertTest", {
      env: { account: "123456789012", region: "us-east-1" },
      config: config(),
    });
    Template.fromStack(stack).hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "login.ctxhost.com",
      SubjectAlternativeNames: ["platform.ctxhost.com", "auth.ccgtradepost.com", "auth.citethemove.com"],
      ValidationMethod: "DNS",
    });
    Template.fromStack(stack).resourceCountIs("AWS::Route53::RecordSet", 0);
    Template.fromStack(stack).hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "CLOUDFRONT",
    });
  });

  it("creates retained prod data resources with no RDS Proxy, rate table, and dump backup schedule", () => {
    const app = new cdk.App();
    const stack = new EngramProdDataStack(app, "DataTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::RDS::DBInstance", 1);
    // The proxy was removed: ~$22/mo to pool a workload peaking at 9 connections.
    template.resourceCountIs("AWS::RDS::DBProxy", 0);
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::Events::Rule", 1);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      EngineVersion: "17.9",
      MultiAZ: false,
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
      DeleteAutomatedBackups: false,
    });
    // No proxy target group either — the pooling contract now lives in the
    // application (src/lib/prisma-config.ts bounds the per-container pool).
    template.resourceCountIs("AWS::RDS::DBProxyTargetGroup", 0);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: [
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "DB_HOST", Value: { "Fn::GetAtt": [Match.stringLikeRegexp("Postgres"), "Endpoint.Address"] } },
            { Name: "METRIC_NAMESPACE", Value: "Engram/ProdBackup" },
          ]),
          Command: Match.arrayWith([
            Match.stringLikeRegexp("set -euo pipefail.*pg_dump.*head-object.*BackupSuccess"),
          ]),
        }),
      ],
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "BackupFailure",
      Namespace: "Engram/ProdBackup",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "BackupSuccess",
      Namespace: "Engram/ProdBackup",
      ComparisonOperator: "LessThanThreshold",
      TreatMissingData: "breaching",
    });
  });

  it("creates the prod OpenNext web tier with RS256 runtime config, WAF, and host aliases", () => {
    const app = new cdk.App();
    const data = new EngramProdDataStack(app, "DataForWebTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
    });
    const web = new EngramProdWebStack(app, "WebTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
      vpc: data.vpc,
      lambdaSecurityGroup: data.lambdaSecurityGroup,
      databaseSecret: data.database.secret!,
      databaseEndpoint: data.database.instanceEndpoint.hostname,
      rateLimitTable: data.rateLimitTable,
    });
    const template = Template.fromStack(web);
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.resourceCountIs("AWS::WAFv2::WebACL", 0);
    template.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "NONE",
    });
    const lambdaPermissions = template.findResources("AWS::Lambda::Permission");
    for (const permission of Object.values(lambdaPermissions)) {
      if (permission.Properties?.Action === "lambda:InvokeFunctionUrl") {
        expect(permission.Properties).not.toHaveProperty("InvokedViaFunctionUrl");
      }
    }
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ENGRAM_DEPLOY_ENV: "prod",
          ENGRAM_URL: "https://login.ctxhost.com",
          ENGRAM_COOKIE_DOMAIN: "",
          ENGRAM_JWT_ALGORITHM: "RS256",
          ENGRAM_JWT_KEY_ID: Match.stringLikeRegexp("cortex/prod/engram/jwt-rs256"),
          ENGRAM_AXON_ENROLLMENT_API_KEY: "{{resolve:secretsmanager:cortex/prod/engram/runtime:SecretString:ENGRAM_AXON_ENROLLMENT_API_KEY}}",
          ENGRAM_ENROLLMENT_SIGNING_SECRET_ID: "cortex/prod/engram/enrollment-signing",
          ENGRAM_ORIGIN_SECRET: "{{resolve:secretsmanager:cortex/prod/engram/runtime:SecretString:ENGRAM_ORIGIN_SECRET}}",
          ENGRAM_ALLOWED_HOSTS:
            "login.ctxhost.com,platform.ctxhost.com,auth.ccgtradepost.com,auth.citethemove.com",
          EMAIL_VERIFIED_DOMAINS:
            "{{resolve:secretsmanager:cortex/prod/engram/runtime:SecretString:EMAIL_VERIFIED_DOMAINS}}",
          RESEND_WEBHOOK_SECRET:
            "{{resolve:secretsmanager:cortex/prod/engram/email:SecretString:RESEND_WEBHOOK_SECRET}}",
          NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING: "https://ccgtradepost.com",
        }),
      },
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["login.ctxhost.com", "platform.ctxhost.com", "auth.ccgtradepost.com", "auth.citethemove.com"],
        DefaultCacheBehavior: Match.objectLike({
          OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        }),
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginCustomHeaders: [
              {
                HeaderName: "x-engram-origin-secret",
                HeaderValue:
                  "{{resolve:secretsmanager:cortex/prod/engram/runtime:SecretString:ENGRAM_ORIGIN_SECRET}}",
              },
            ],
          }),
        ]),
        WebACLId:
          "arn:aws:wafv2:us-east-1:123456789012:global/webacl/engram-prod/00000000-0000-0000-0000-000000000000",
      }),
    });
    const route53Records = template.findResources("AWS::Route53::RecordSet");
    const recordNames = Object.values(route53Records).map((record) => record.Properties?.Name);
    expect(recordNames).toContain("login.ctxhost.com.");
    expect(recordNames).toContain("platform.ctxhost.com.");
    expect(recordNames).not.toContain("auth.ccgtradepost.com.");
    expect(recordNames).not.toContain("auth.citethemove.com.");
    const server = Object.values(template.findResources("AWS::Lambda::Function")).find(
      (resource) => resource.Properties?.Environment?.Variables?.ENGRAM_DEPLOY_ENV === "prod",
    );
    expect(server?.Properties?.Environment?.Variables).not.toHaveProperty("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID");
    const environment = server?.Properties?.Environment?.Variables as Record<string, string>;

    // The signing secret is referenced by NAME. Injecting its contents is what
    // exceeded Lambda's configuration-request limit and rolled prod back on
    // 2026-08-04; the function loads them lazily at runtime instead.
    expect(environment.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID).toBe(
      "cortex/prod/engram/enrollment-signing",
    );
    expect(environment.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID).not.toContain("resolve:secretsmanager");
    for (const name of [
      "ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY",
      "ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY",
      "ENGRAM_ENROLLMENT_SIGNING_KEY_ID",
      "ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE",
      "ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER",
    ]) {
      expect(environment).not.toHaveProperty(name);
    }
    // Enrollment must still never borrow the JWT signing material (ADR-034 §5).
    expect(environment.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID).not.toContain("jwt-rs256");
    expect(environment.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID).not.toBe(environment.ENGRAM_JWT_KEY_ID);
  });

  it("never injects key material into the prod Lambda environment", () => {
    // AWS rejects UpdateFunctionConfiguration above 5120 bytes with HTTP 413.
    // That fails the STACK UPDATE and rolls back; no test of application
    // behaviour catches it, and it bit prod on 2026-08-04.
    //
    // Byte-counting the template alone would NOT have caught it: a
    // {{resolve:...}} ref to a 2.5 KB PEM is ~90 bytes here and only expands
    // when AWS substitutes it at deploy time. So the load-bearing assertion is
    // structural — no environment variable may carry key material from ANY
    // secret, by value or by reference. The byte bound is a secondary guard
    // against someone inlining a large literal.
    const app = new cdk.App();
    const data = new EngramProdDataStack(app, "DataForBudgetTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
    });
    const web = new EngramProdWebStack(app, "WebBudgetTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
      vpc: data.vpc,
      lambdaSecurityGroup: data.lambdaSecurityGroup,
      databaseSecret: data.database.secret!,
      databaseEndpoint: data.database.instanceEndpoint.hostname,
      rateLimitTable: data.rateLimitTable,
    });
    const template = Template.fromStack(web);
    const server = Object.values(template.findResources("AWS::Lambda::Function")).find(
      (resource) => resource.Properties?.Environment?.Variables?.ENGRAM_DEPLOY_ENV === "prod",
    );
    const environment = server?.Properties?.Environment?.Variables as Record<string, unknown>;

    // PEM fields are the ones large enough to blow the budget.
    //
    // ENGRAM_JWT_PRIVATE_KEY is a KNOWN, pre-existing exception: it is still
    // injected inline and costs ~1732 B of the 5120 budget. It is excluded
    // rather than silently tolerated — moving it to a runtime fetch touches
    // every authentication request, so it is deliberately a separate change.
    // It is the first thing to move if this budget tightens again.
    const KNOWN_INLINE_KEY_MATERIAL = new Set([
      "ENGRAM_JWT_PRIVATE_KEY",
      "ENGRAM_JWT_PUBLIC_KEY",
    ]);
    for (const [key, value] of Object.entries(environment)) {
      if (KNOWN_INLINE_KEY_MATERIAL.has(key)) continue;
      const rendered = JSON.stringify(value);
      expect(
        rendered,
        `${key} must not carry key material — load it at runtime instead`,
      ).not.toMatch(/SecretString:(privateKeyPem|publicKeyPem)/);
      expect(rendered, `${key} must not inline a PEM`).not.toContain("BEGIN ");
    }

    const bytes = Object.entries(environment).reduce(
      (total, [key, value]) => total + key.length + JSON.stringify(value).length,
      0,
    );
    expect(bytes).toBeLessThan(4096);
  });

  it("binds overlap values only when a dedicated rotation secret is configured", () => {
    const app = new cdk.App();
    const configured = config({ enrollmentOverlapSecretName: "cortex/prod/engram/enrollment-overlap" });
    const data = new EngramProdDataStack(app, "DataForOverlapTest", {
      env: { account: "123456789012", region: "us-west-2" }, config: configured,
    });
    const web = new EngramProdWebStack(app, "WebOverlapTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: configured,
      vpc: data.vpc,
      lambdaSecurityGroup: data.lambdaSecurityGroup,
      databaseSecret: data.database.secret!,
      databaseEndpoint: data.database.instanceEndpoint.hostname,
      rateLimitTable: data.rateLimitTable,
    });
    const functions = Template.fromStack(web).findResources("AWS::Lambda::Function");
    const server = Object.values(functions).find(
      (resource) => resource.Properties?.Environment?.Variables?.ENGRAM_DEPLOY_ENV === "prod",
    );
    expect(server?.Properties?.Environment?.Variables).toMatchObject({
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "{{resolve:secretsmanager:cortex/prod/engram/enrollment-overlap:SecretString:ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID}}",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: "{{resolve:secretsmanager:cortex/prod/engram/enrollment-overlap:SecretString:ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY}}",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: "{{resolve:secretsmanager:cortex/prod/engram/enrollment-overlap:SecretString:ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE}}",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "{{resolve:secretsmanager:cortex/prod/engram/enrollment-overlap:SecretString:ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER}}",
    });
  });

  it("creates the dispatch deploy role and budget in the ops stack", () => {
    const app = new cdk.App();
    const stack = new EngramProdOpsStack(app, "OpsTest", {
      env: { account: "123456789012", region: "us-west-2" },
      config: config(),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "EngramAwsProdGithubDeploy",
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: Match.objectLike({
                "token.actions.githubusercontent.com:sub":
                  "repo:cortex-mesh/engram:environment:aws-prod",
              }),
            },
          }),
        ],
      }),
      Policies: [
        Match.objectLike({
          PolicyDocument: {
            Statement: [
              Match.objectLike({
                Action: "sts:AssumeRole",
                Resource: Match.arrayWith([
                  "arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-*",
                ]),
              }),
            ],
            Version: "2012-10-17",
          },
        }),
      ],
    });
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      NotificationsWithSubscribers: [
        Match.objectLike({
          Subscribers: [{ Address: "ops@example.com", SubscriptionType: "EMAIL" }],
        }),
      ],
    });
  });
});
