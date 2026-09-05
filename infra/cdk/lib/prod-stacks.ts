import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Construct } from "constructs";

export const PROD_AUTH_HOSTNAME = "auth.citethemove.com";
export const PROD_AUTH_HOSTNAMES = [
  "login.ctxhost.com",
  "platform.ctxhost.com",
  "auth.ccgtradepost.com",
  PROD_AUTH_HOSTNAME,
];
const PROD_ROUTE53_ALIAS_RECORDS = ["login", "platform"];

export interface ProdStackConfig {
  hostedZoneId: string;
  hostedZoneName: string;
  certificateArn: string;
  webAclArn: string;
  openNextOutputPath: string;
  databaseName: string;
  dbInstanceClass: string;
  dbAllocatedStorageGiB: number;
  monthlyBudgetUsd: number;
  alertEmail: string;
  engramUrl: string;
  platformUrl: string;
  tradepostUrl: string;
  secretPrefix: string;
  /** Separate secret is supplied only during an active K2/K1 overlap. */
  enrollmentOverlapSecretName?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for ENGRAM_ENABLE_PROD_STACKS=1`);
  return value;
}

type ProdWebArnName = "ENGRAM_PROD_CERTIFICATE_ARN" | "ENGRAM_PROD_WEB_ACL_ARN";

function requireProdWebArn(name: ProdWebArnName, value = process.env[name]): string {
  const normalized = value?.trim();
  if (!normalized || normalized === "None" || normalized === "null") {
    throw new Error(`${name} is required when synthesizing engram-prod-web`);
  }
  return normalized;
}

export function hasProdWebInputs(config?: Pick<ProdStackConfig, "certificateArn" | "webAclArn">): boolean {
  const certificateArn = config?.certificateArn ?? process.env.ENGRAM_PROD_CERTIFICATE_ARN;
  const webAclArn = config?.webAclArn ?? process.env.ENGRAM_PROD_WEB_ACL_ARN;
  if (!certificateArn?.trim() && !webAclArn?.trim()) return false;

  requireProdWebArn("ENGRAM_PROD_CERTIFICATE_ARN", certificateArn);
  requireProdWebArn("ENGRAM_PROD_WEB_ACL_ARN", webAclArn);
  return true;
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

export function loadProdStackConfigFromEnv(): ProdStackConfig {
  return {
    hostedZoneId: requireEnv("ENGRAM_PROD_HOSTED_ZONE_ID"),
    hostedZoneName: process.env.ENGRAM_PROD_HOSTED_ZONE_NAME || "ctxhost.com",
    certificateArn: process.env.ENGRAM_PROD_CERTIFICATE_ARN?.trim() || "",
    webAclArn: process.env.ENGRAM_PROD_WEB_ACL_ARN?.trim() || "",
    openNextOutputPath:
      process.env.ENGRAM_PROD_OPEN_NEXT_OUTPUT_PATH ||
      resolve(import.meta.dirname, "..", "..", "..", ".open-next"),
    databaseName: process.env.ENGRAM_PROD_DATABASE_NAME || "engram",
    dbInstanceClass: process.env.ENGRAM_PROD_DB_INSTANCE_CLASS || "t4g.micro",
    dbAllocatedStorageGiB: envNumber("ENGRAM_PROD_DB_ALLOCATED_STORAGE_GIB", 20),
    monthlyBudgetUsd: envNumber("ENGRAM_PROD_MONTHLY_BUDGET_USD", 110),
    alertEmail: process.env.ENGRAM_PROD_BUDGET_ALERT_EMAIL || "ops@example.com",
    engramUrl: process.env.ENGRAM_PROD_ENGRAM_URL || "https://login.ctxhost.com",
    platformUrl: process.env.ENGRAM_PROD_PLATFORM_URL || "https://platform.ctxhost.com",
    tradepostUrl: process.env.ENGRAM_PROD_TRADEPOST_URL || "https://ccgtradepost.com",
    secretPrefix: process.env.ENGRAM_PROD_SECRET_PREFIX || "cortex/prod/engram",
    enrollmentOverlapSecretName: process.env.ENGRAM_PROD_ENROLLMENT_OVERLAP_SECRET_NAME?.trim() || undefined,
  };
}

function secretJsonRef(secretName: string, field: string): string {
  return `{{resolve:secretsmanager:${secretName}:SecretString:${field}}}`;
}

function normalizeRdsInstanceClass(value: string): string {
  return value.startsWith("db.") ? value.slice(3) : value;
}

export class EngramProdCertStack extends cdk.Stack {
  readonly certificate: acm.Certificate;
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: cdk.StackProps & { config: ProdStackConfig }) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: PROD_AUTH_HOSTNAMES[0],
      subjectAlternativeNames: PROD_AUTH_HOSTNAMES.slice(1),
      // Branded auth hosts are Cloudflare-hosted, so the controller publishes
      // ACM validation records out-of-band instead of Route53.
      validation: acm.CertificateValidation.fromDns(),
    });
    // CloudFront-scoped WAFv2 WebACLs are global resources that must be
    // created from us-east-1, matching the ACM certificate stack.
    this.webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      defaultAction: { allow: {} },
      scope: "CLOUDFRONT",
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "engramProdWebAcl", sampledRequestsEnabled: true },
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "common", sampledRequestsEnabled: true },
        },
        {
          name: "RateLimit",
          priority: 2,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "rateLimit", sampledRequestsEnabled: true },
        },
      ],
    });
    new cdk.CfnOutput(this, "CertificateArn", { value: this.certificate.certificateArn });
    new cdk.CfnOutput(this, "WebAclArn", { value: this.webAcl.attrArn });
  }
}

export class EngramProdDataStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly database: rds.DatabaseInstance;
  readonly lambdaSecurityGroup: ec2.SecurityGroup;
  readonly rateLimitTable: dynamodb.Table;
  readonly backupBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: cdk.StackProps & { config: ProdStackConfig }) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private-egress", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "database", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc: this.vpc,
      description: "Engram prod PostgreSQL security group",
      allowAllOutbound: true,
    });
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, "LambdaSecurityGroup", {
      vpc: this.vpc,
      description: "Engram prod OpenNext Lambda security group",
      allowAllOutbound: true,
    });
    const backupSecurityGroup = new ec2.SecurityGroup(this, "BackupSecurityGroup", {
      vpc: this.vpc,
      description: "Engram prod dump backup task security group",
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(backupSecurityGroup, ec2.Port.tcp(5432), "Postgres dump backup direct from ECS task");
    // The Lambda reaches Postgres directly. The RDS Proxy that used to sit in
    // between was removed: it cost ~$22/mo to pool a workload that peaked at 9
    // concurrent executions and 9 backend connections. src/lib/prisma-config.ts
    // caps the per-container pool so concurrency cannot exhaust the instance.
    dbSecurityGroup.addIngressRule(this.lambdaSecurityGroup, ec2.Port.tcp(5432), "Postgres direct from Lambda");

    this.database = new rds.DatabaseInstance(this, "Postgres", {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      // AWS retires RDS minor versions; hard pins eventually 400 at deploy
      // and must be refreshed. Match aws-dev's currently proven 17.9 engine.
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17_9 }),
      instanceType: new ec2.InstanceType(normalizeRdsInstanceClass(props.config.dbInstanceClass)),
      allocatedStorage: props.config.dbAllocatedStorageGiB,
      storageType: rds.StorageType.GP3,
      // Roland cost amendment 2026-07-14: single-AZ trades availability,
      // not data safety. Keep PITR, retained snapshots, deletion protection,
      // deleteAutomatedBackups=false, and the independent dump job/alarms.
      multiAz: false,
      publiclyAccessible: false,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(14),
      credentials: rds.Credentials.fromGeneratedSecret("engram", {
        secretName: `${props.config.secretPrefix}/db-admin`,
      }),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deleteAutomatedBackups: false,
    });

    this.rateLimitTable = new dynamodb.Table(this, "RateLimitTable", {
      partitionKey: { name: "rateKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    this.backupBucket = new s3.Bucket(this, "DumpBackupBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const cluster = new ecs.Cluster(this, "BackupCluster", { vpc: this.vpc });
    const backupTask = new ecs.FargateTaskDefinition(this, "DumpBackupTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    this.backupBucket.grantWrite(backupTask.taskRole);
    this.backupBucket.grantRead(backupTask.taskRole);
    this.database.secret!.grantRead(backupTask.taskRole);
    backupTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "Engram/ProdBackup" },
        },
      }),
    );
    backupTask.addContainer("PgDump", {
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/postgres:17-alpine"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "pg-dump",
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        DB_HOST: this.database.dbInstanceEndpointAddress,
        DB_NAME: props.config.databaseName,
        BACKUP_BUCKET: this.backupBucket.bucketName,
        METRIC_NAMESPACE: "Engram/ProdBackup",
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(this.database.secret!, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(this.database.secret!, "password"),
      },
      command: [
        "sh",
        "-lc",
        "apk add --no-cache aws-cli bash gzip >/tmp/apk.log && exec bash -lc 'set -euo pipefail; fail() { aws cloudwatch put-metric-data --namespace \"$METRIC_NAMESPACE\" --metric-name BackupFailure --value 1 --unit Count || true; }; trap fail ERR; export PGPASSWORD=\"$DB_PASSWORD\"; KEY=\"engram/$(date -u +%Y-%m-%dT%H-%M-%SZ).sql.gz\"; pg_dump --host \"$DB_HOST\" --username \"$DB_USERNAME\" --dbname \"$DB_NAME\" --no-owner --no-acl | gzip > /tmp/engram.sql.gz; test -s /tmp/engram.sql.gz; aws s3 cp /tmp/engram.sql.gz \"s3://$BACKUP_BUCKET/$KEY\"; SIZE=$(aws s3api head-object --bucket \"$BACKUP_BUCKET\" --key \"$KEY\" --query ContentLength --output text); test \"$SIZE\" -gt 0; aws cloudwatch put-metric-data --namespace \"$METRIC_NAMESPACE\" --metric-name BackupSuccess --value 1 --unit Count'",
      ],
    });
    new events.Rule(this, "DailyDumpBackupSchedule", {
      schedule: events.Schedule.cron({ minute: "0", hour: "9" }),
      targets: [
        new eventsTargets.EcsTask({
          cluster,
          taskDefinition: backupTask,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [backupSecurityGroup],
        }),
      ],
    });
    new cloudwatch.Alarm(this, "DumpBackupFailureAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "Engram/ProdBackup",
        metricName: "BackupFailure",
        statistic: "sum",
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "DumpBackupMissingAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "Engram/ProdBackup",
        metricName: "BackupSuccess",
        statistic: "sum",
        period: cdk.Duration.hours(26),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    new cdk.CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    // scripts/prod-db-migrate.sh reads this rather than hardcoding a hostname.
    new cdk.CfnOutput(this, "DatabaseEndpoint", { value: this.database.instanceEndpoint.hostname });
    new cdk.CfnOutput(this, "RateLimitTableName", { value: this.rateLimitTable.tableName });
    new cdk.CfnOutput(this, "DumpBackupBucketName", { value: this.backupBucket.bucketName });
  }
}

export interface EngramProdWebStackProps extends cdk.StackProps {
  config: ProdStackConfig;
  vpc: ec2.IVpc;
  lambdaSecurityGroup: ec2.ISecurityGroup;
  databaseSecret: secretsmanager.ISecret;
  /**
   * Postgres host for DATABASE_URL. This is the RDS instance endpoint, not the
   * RDS Proxy — see the Lambda ingress rule in EngramProdDataStack. The
   * instance hostname is ~32 bytes longer than the proxy's, which matters only
   * against the 5120-byte Lambda environment ceiling
   * (docs/runbooks/aws-prod-lambda-env-budget.md); measured headroom at the
   * time of the switch was 1388 bytes.
   */
  databaseEndpoint: string;
  rateLimitTable: dynamodb.ITable;
}

export class EngramProdWebStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EngramProdWebStackProps) {
    super(scope, id, props);

    const certificateArn = requireProdWebArn("ENGRAM_PROD_CERTIFICATE_ARN", props.config.certificateArn);
    const webAclArn = requireProdWebArn("ENGRAM_PROD_WEB_ACL_ARN", props.config.webAclArn);

    const outputPath = resolve(props.config.openNextOutputPath);
    const serverPath = resolve(outputPath, "server-functions", "default");
    const assetsPath = resolve(outputPath, "assets");
    if (!existsSync(serverPath) || !existsSync(assetsPath)) {
      throw new Error(`OpenNext output is missing at ${outputPath}; run npm run build:opennext before synthesizing ${id}`);
    }

    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new s3deploy.BucketDeployment(this, "AssetsDeployment", {
      destinationBucket: assetsBucket,
      sources: [s3deploy.Source.asset(assetsPath)],
      prune: true,
    });

    const runtimeSecretName = `${props.config.secretPrefix}/runtime`;
    const oauthSecretName = `${props.config.secretPrefix}/oauth-google`;
    const emailSecretName = `${props.config.secretPrefix}/email`;
    const jwtSecretName = `${props.config.secretPrefix}/jwt-rs256`;
    // Enrollment signatures are a distinct trust domain from user access
    // tokens. Keep key material and its validity window in one atomically
    // rotated secret so JWT rotation never retires enrollment history.
    const enrollmentSigningSecretName = `${props.config.secretPrefix}/enrollment-signing`;
    const runtimeSecret = secretsmanager.Secret.fromSecretNameV2(this, "RuntimeSecret", runtimeSecretName);
    const overlapSecretName = props.config.enrollmentOverlapSecretName;
    const overlapSecret = overlapSecretName
      ? secretsmanager.Secret.fromSecretNameV2(this, "EnrollmentOverlapSecret", overlapSecretName)
      : undefined;
    const overlapEnvironment: Record<string, string> = {};
    if (overlapSecretName) Object.assign(overlapEnvironment, {
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: secretJsonRef(overlapSecretName, "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID"),
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: secretJsonRef(overlapSecretName, "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY"),
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: secretJsonRef(overlapSecretName, "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE"),
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: secretJsonRef(overlapSecretName, "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER"),
    });
    const oauthSecret = secretsmanager.Secret.fromSecretNameV2(this, "GoogleOauthSecret", oauthSecretName);
    const emailSecret = secretsmanager.Secret.fromSecretNameV2(this, "EmailSecret", emailSecretName);
    const jwtSecret = secretsmanager.Secret.fromSecretNameV2(this, "JwtSecret", jwtSecretName);
    const enrollmentSigningSecret = secretsmanager.Secret.fromSecretNameV2(this, "EnrollmentSigningSecret", enrollmentSigningSecretName);

    const server = new lambda.Function(this, "ServerFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(serverPath),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      logGroup: new logs.LogGroup(this, "ServerLogGroup", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }),
      environment: {
        NODE_ENV: "production",
        ENGRAM_DEPLOY_ENV: "prod",
        ENGRAM_URL: props.config.engramUrl,
        ENGRAM_COOKIE_DOMAIN: "",
        ENGRAM_RATE_LIMIT_DYNAMODB_TABLE: props.rateLimitTable.tableName,
        ENGRAM_JWT_ALGORITHM: "RS256",
        ENGRAM_JWT_KEY_ID: secretJsonRef(jwtSecretName, "kid"),
        ENGRAM_JWT_PRIVATE_KEY: secretJsonRef(jwtSecretName, "privateKeyPem"),
        ENGRAM_JWT_PUBLIC_KEY: secretJsonRef(jwtSecretName, "publicKeyPem"),
        ENGRAM_INTERNAL_API_KEY: secretJsonRef(runtimeSecretName, "ENGRAM_INTERNAL_API_KEY"),
        ENGRAM_AXON_ENROLLMENT_API_KEY: secretJsonRef(runtimeSecretName, "ENGRAM_AXON_ENROLLMENT_API_KEY"),
        // Pass the secret NAME, not its contents. Lambda caps a configuration
        // update request at 5120 bytes; these five fields are ~3.3 KB of it,
        // and injecting them here made UpdateFunctionConfiguration fail with
        // HTTP 413 and rolled the web stack back (2026-08-04). The function
        // fetches and caches them lazily on the first enrollment request —
        // never at startup, which ADR-034 §8.1 forbids on the shared IdP.
        // See docs/runbooks/aws-prod-lambda-env-budget.md.
        ENGRAM_ENROLLMENT_SIGNING_SECRET_ID: enrollmentSigningSecretName,
        ...overlapEnvironment,
        ENGRAM_ORIGIN_SECRET: secretJsonRef(runtimeSecretName, "ENGRAM_ORIGIN_SECRET"),
        // Public host routing belongs to the same IaC authority as the
        // CloudFront aliases and certificate SANs.
        ENGRAM_ALLOWED_HOSTS: PROD_AUTH_HOSTNAMES.join(","),
        EMAIL_VERIFIED_DOMAINS: secretJsonRef(runtimeSecretName, "EMAIL_VERIFIED_DOMAINS"),
        ENGRAM_GOOGLE_CLIENT_ID: secretJsonRef(oauthSecretName, "clientId"),
        ENGRAM_GOOGLE_CLIENT_SECRET: secretJsonRef(oauthSecretName, "clientSecret"),
        RESEND_API_KEY: secretJsonRef(emailSecretName, "RESEND_API_KEY"),
        RESEND_WEBHOOK_SECRET: secretJsonRef(emailSecretName, "RESEND_WEBHOOK_SECRET"),
        EMAIL_FROM: secretJsonRef(emailSecretName, "EMAIL_FROM"),
        DATABASE_URL: `postgresql://${secretJsonRef(`${props.config.secretPrefix}/db-admin`, "username")}:${secretJsonRef(`${props.config.secretPrefix}/db-admin`, "password")}@${props.databaseEndpoint}:5432/${props.config.databaseName}?sslmode=require`,
        NEXT_PUBLIC_DASHBOARD_URL: props.config.platformUrl,
        NEXT_PUBLIC_SYNAPSE_URL: props.config.platformUrl,
        NEXT_PUBLIC_THOUGHTS_URL: props.config.platformUrl,
        NEXT_PUBLIC_AXON_URL: props.config.platformUrl,
        NEXT_PUBLIC_PULSE_URL: props.config.platformUrl,
        NEXT_PUBLIC_GYRUS_URL: props.config.platformUrl,
        NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING: props.config.tradepostUrl,
      },
    });
    props.rateLimitTable.grantReadWriteData(server);
    props.databaseSecret.grantRead(server);
    runtimeSecret.grantRead(server);
    overlapSecret?.grantRead(server);
    oauthSecret.grantRead(server);
    emailSecret.grantRead(server);
    jwtSecret.grantRead(server);
    enrollmentSigningSecret.grantRead(server);

    // Lambda Function URL OAC SigV4 signing cannot coexist with forwarding the
    // Authorization header Engram needs for Bearer-token clients. Keep the
    // Function URL unauthenticated and fail closed in middleware unless
    // CloudFront supplies this origin secret.
    const functionUrl = server.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    const certificate = acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn);

    const forwardedHost = new cloudfront.Function(this, "ForwardedHostFunction", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.headers["x-forwarded-host"] = request.headers.host;
  return request;
}
`),
    });
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      certificate,
      domainNames: PROD_AUTH_HOSTNAMES,
      webAclId: webAclArn,
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(functionUrl, {
          customHeaders: {
            "x-engram-origin-secret": secretJsonRef(runtimeSecretName, "ENGRAM_ORIGIN_SECRET"),
          },
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: forwardedHost }],
      },
      additionalBehaviors: {
        "_next/static/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    });
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: props.config.hostedZoneId,
      zoneName: props.config.hostedZoneName,
    });
    // Branded auth host DNS lives in Cloudflare; only ctxhost aliases are
    // managed here. Synthesis deliberately creates neither Route53 records
    // nor any deployment-time DNS mutation for PROD_AUTH_HOSTNAME.
    for (const recordName of PROD_ROUTE53_ALIAS_RECORDS) {
      new route53.ARecord(this, `Alias${recordName}`, {
        zone,
        recordName,
        target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(this.distribution)),
      });
    }

    new cdk.CfnOutput(this, "DistributionDomainName", { value: this.distribution.distributionDomainName });
  }
}

export class EngramProdOpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { config: ProdStackConfig }) {
    super(scope, id, props);

    new iam.Role(this, "EngramAwsProdGithubDeploy", {
      roleName: "EngramAwsProdGithubDeploy",
      assumedBy: new iam.FederatedPrincipal(
        `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": "repo:cortex-mesh/engram:environment:aws-prod",
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
      inlinePolicies: {
        CdkDeploy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["sts:AssumeRole"],
              resources: [
                `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-*`,
                `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-*`,
                `arn:aws:iam::${this.account}:role/cdk-hnb659fds-image-publishing-role-${this.account}-*`,
                `arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-*`,
              ],
            }),
          ],
        }),
      },
    });

    const subscribers = [{ subscriptionType: "EMAIL", address: props.config.alertEmail }];
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "engram-prod-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.config.monthlyBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: subscribers
        ? [
            {
              notification: {
                notificationType: "ACTUAL",
                comparisonOperator: "GREATER_THAN",
                threshold: 80,
              },
              subscribers,
            },
          ]
        : undefined,
    });
  }
}

/**
 * Cost-allocation tags, applied per stack rather than to the whole App.
 *
 * This repo's CDK app also declares the `cortex-*` stacks, which engram does
 * not own or deploy — tagging at App level would stamp app=engram onto cortex
 * infrastructure if anyone ever synthesized it from here. Tagging the prod
 * stacks individually keeps the attribution honest.
 *
 * `app` and `env` are the account's two activated cost-allocation tags. Without
 * them engram's spend lands in Cost Explorer's untagged bucket and has to be
 * reconstructed by hand from usage types — which is exactly how the 2026-08-14
 * cost baseline had to be built. Matches tradepost/infra/bin/tradepost.ts.
 */
function tagProdStack(stack: cdk.Stack): void {
  cdk.Tags.of(stack).add("app", "engram");
  cdk.Tags.of(stack).add("env", "prod");
  cdk.Tags.of(stack).add("repo", "cortex-mesh/engram");
  cdk.Tags.of(stack).add("managed-by", "cdk");
}

export function addEngramProdStacks(app: cdk.App, config: ProdStackConfig, env: cdk.Environment) {
  tagProdStack(
    new EngramProdCertStack(app, "engram-prod-cert", {
      config,
      env: { ...env, region: "us-east-1" },
      stackName: "engram-prod-cert",
    }),
  );

  tagProdStack(
    new EngramProdOpsStack(app, "engram-prod-ops", {
      config,
      env,
      stackName: "engram-prod-ops",
    }),
  );

  const prodData = new EngramProdDataStack(app, "engram-prod-data", {
    config,
    env,
    stackName: "engram-prod-data",
  });
  tagProdStack(prodData);

  // A first cert-stack deployment has no CertificateArn/WebAclArn outputs yet.
  // Data does not consume them, but web must never synthesize with placeholders.
  if (!hasProdWebInputs(config)) {
    console.error(
      "warning: ENGRAM_PROD_CERTIFICATE_ARN and ENGRAM_PROD_WEB_ACL_ARN are empty or unavailable; omitting engram-prod-web because it requires the live cert-stack outputs.",
    );
    return;
  }

  const prodWeb = new EngramProdWebStack(app, "engram-prod-web", {
    config,
    env,
    stackName: "engram-prod-web",
    vpc: prodData.vpc,
    lambdaSecurityGroup: prodData.lambdaSecurityGroup,
    databaseSecret: prodData.database.secret!,
    databaseEndpoint: prodData.database.instanceEndpoint.hostname,
    rateLimitTable: prodData.rateLimitTable,
  });
  tagProdStack(prodWeb);
  prodWeb.addDependency(prodData);
}
