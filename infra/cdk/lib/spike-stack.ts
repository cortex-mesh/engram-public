import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Construct } from "constructs";

export interface SpikeStackConfig {
  vpcId: string;
  publicSubnetId: string;
  privateSubnetIds: string[];
  privateRouteTableIds: string[];
  dbSecurityGroupId: string;
  dbInstanceIdentifier: string;
  dbEndpointAddress: string;
  dbProxyAuthSecretArn: string;
  runtimeSecretName: string;
  enrollmentSigningSecretName: string;
  enrollmentOverlapSecretName?: string;
  openNextOutputPath: string;
  engramUrl: string;
  databaseName: string;
  nextPublicDashboardUrl: string;
  nextPublicSynapseUrl: string;
  nextPublicThoughtsUrl: string;
  nextPublicAxonUrl: string;
  nextPublicPulseUrl: string;
  nextPublicGyrusUrl: string;
}

export interface SpikeStackProps extends cdk.StackProps {
  config: SpikeStackConfig;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for ENGRAM_ENABLE_SPIKE_STACK=1`);
  return value;
}

function envList(name: string): string[] {
  return requireEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadSpikeStackConfigFromEnv(): SpikeStackConfig {
  return {
    vpcId: requireEnv("ENGRAM_SPIKE_VPC_ID"),
    publicSubnetId: requireEnv("ENGRAM_SPIKE_PUBLIC_SUBNET_ID"),
    privateSubnetIds: envList("ENGRAM_SPIKE_PRIVATE_SUBNET_IDS"),
    privateRouteTableIds: envList("ENGRAM_SPIKE_PRIVATE_ROUTE_TABLE_IDS"),
    dbSecurityGroupId: requireEnv("ENGRAM_SPIKE_DB_SECURITY_GROUP_ID"),
    dbInstanceIdentifier: requireEnv("ENGRAM_SPIKE_DB_INSTANCE_IDENTIFIER"),
    dbEndpointAddress: requireEnv("ENGRAM_SPIKE_DB_ENDPOINT_ADDRESS"),
    dbProxyAuthSecretArn: requireEnv("ENGRAM_SPIKE_DB_PROXY_AUTH_SECRET_ARN"),
    runtimeSecretName:
      process.env.ENGRAM_SPIKE_RUNTIME_SECRET_NAME || "engram-dev-runtime",
    enrollmentSigningSecretName:
      process.env.ENGRAM_SPIKE_ENROLLMENT_SIGNING_SECRET_NAME ||
      "engram-dev-enrollment-signing",
    enrollmentOverlapSecretName:
      process.env.ENGRAM_SPIKE_ENROLLMENT_OVERLAP_SECRET_NAME?.trim() ||
      undefined,
    openNextOutputPath:
      process.env.ENGRAM_SPIKE_OPEN_NEXT_OUTPUT_PATH ||
      resolve(import.meta.dirname, "..", "..", "..", ".open-next"),
    engramUrl:
      process.env.ENGRAM_SPIKE_ENGRAM_URL || "https://login.dev.ctxhost.com",
    databaseName: process.env.ENGRAM_SPIKE_DATABASE_NAME || "engram",
    nextPublicDashboardUrl:
      process.env.ENGRAM_SPIKE_NEXT_PUBLIC_DASHBOARD_URL ||
      "https://plexus.dev.ctxhost.com",
    nextPublicSynapseUrl:
      process.env.ENGRAM_SPIKE_NEXT_PUBLIC_SYNAPSE_URL ||
      "https://cortex.dev.ctxhost.com/synapse",
    nextPublicThoughtsUrl:
      process.env.ENGRAM_SPIKE_NEXT_PUBLIC_THOUGHTS_URL ||
      "https://cortex.dev.ctxhost.com/thoughts",
    nextPublicAxonUrl:
      process.env.ENGRAM_SPIKE_NEXT_PUBLIC_AXON_URL ||
      "https://cortex.dev.ctxhost.com/axon",
    nextPublicPulseUrl:
      process.env.ENGRAM_SPIKE_NEXT_PUBLIC_PULSE_URL ||
      "https://cortex.dev.ctxhost.com/pulse",
    nextPublicGyrusUrl:
      process.env.ENGRAM_SPIKE_NEXT_PUBLIC_GYRUS_URL ||
      "https://cortex.dev.ctxhost.com/gyrus",
  };
}

function secretJsonRef(secretName: string, field: string): string {
  return `{{resolve:secretsmanager:${secretName}:SecretString:${field}}}`;
}

function secretArnJsonRef(secretArn: string, field: string): string {
  return `{{resolve:secretsmanager:${secretArn}:SecretString:${field}}}`;
}

function functionUrlDomain(url: string): string {
  return cdk.Fn.select(2, cdk.Fn.split("/", url));
}

export class EngramSpikeStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;
  readonly functionUrl: lambda.FunctionUrl;
  readonly rateLimitTable: dynamodb.Table;
  readonly rdsProxy: rds.DatabaseProxy;

  constructor(scope: Construct, id: string, props: SpikeStackProps) {
    super(scope, id, props);

    const outputPath = resolve(props.config.openNextOutputPath);
    const serverPath = resolve(outputPath, "server-functions", "default");
    const assetsPath = resolve(outputPath, "assets");
    if (!existsSync(serverPath) || !existsSync(assetsPath)) {
      throw new Error(
        `OpenNext output is missing at ${outputPath}; run npm run build:opennext before synthesizing ${id}`,
      );
    }

    const privateSubnets = props.config.privateSubnetIds.map(
      (subnetId, index) =>
        ec2.Subnet.fromSubnetId(this, `PrivateSubnet${index + 1}`, subnetId),
    );
    if (
      props.config.privateRouteTableIds.length !==
      props.config.privateSubnetIds.length
    ) {
      throw new Error(
        "ENGRAM_SPIKE_PRIVATE_ROUTE_TABLE_IDS must contain one route table ID per private subnet",
      );
    }
    const vpc = ec2.Vpc.fromVpcAttributes(this, "DevVpc", {
      vpcId: props.config.vpcId,
      availabilityZones: privateSubnets.map(
        (_subnet, index) => `${this.region}${index === 0 ? "a" : "b"}`,
      ),
      privateSubnetIds: props.config.privateSubnetIds,
    });

    const natEip = new ec2.CfnEIP(this, "NatEip", {
      domain: "vpc",
    });
    const natGateway = new ec2.CfnNatGateway(this, "NatGateway", {
      allocationId: natEip.attrAllocationId,
      subnetId: props.config.publicSubnetId,
    });
    props.config.privateRouteTableIds.forEach((routeTableId, index) => {
      new ec2.CfnRoute(this, `PrivateDefaultRoute${index + 1}`, {
        routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        natGatewayId: natGateway.ref,
      });
    });

    const dbSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "DevDbSecurityGroup",
      props.config.dbSecurityGroupId,
      { mutable: true },
    );
    const lambdaSecurityGroup = new ec2.SecurityGroup(
      this,
      "ServerSecurityGroup",
      {
        vpc,
        description: "Engram OpenNext spike Lambda security group",
        allowAllOutbound: true,
      },
    );
    const proxySecurityGroup = new ec2.SecurityGroup(
      this,
      "ProxySecurityGroup",
      {
        vpc,
        description: "Temporary Engram OpenNext spike RDS Proxy security group",
        allowAllOutbound: true,
      },
    );
    proxySecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      "Postgres from spike Lambda",
    );
    dbSecurityGroup.addIngressRule(
      proxySecurityGroup,
      ec2.Port.tcp(5432),
      "Postgres from spike proxy",
    );

    const dbProxyAuthSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "DevDatabaseProxyAuthSecret",
      props.config.dbProxyAuthSecretArn,
    );
    const runtimeSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "DevRuntimeSecret",
      props.config.runtimeSecretName,
    );
    const database = rds.DatabaseInstance.fromDatabaseInstanceAttributes(
      this,
      "DevDatabase",
      {
        instanceIdentifier: props.config.dbInstanceIdentifier,
        instanceEndpointAddress: props.config.dbEndpointAddress,
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_17_4,
        }),
        port: 5432,
        securityGroups: [dbSecurityGroup],
      },
    );
    this.rdsProxy = new rds.DatabaseProxy(this, "DevRdsProxy", {
      proxyTarget: rds.ProxyTarget.fromInstance(database),
      secrets: [dbProxyAuthSecret],
      vpc,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [proxySecurityGroup],
      requireTLS: true,
      iamAuth: false,
      debugLogging: true,
      maxConnectionsPercent: 10,
      maxIdleConnectionsPercent: 5,
      borrowTimeout: cdk.Duration.seconds(30),
    });

    this.rateLimitTable = new dynamodb.Table(this, "RateLimitTable", {
      partitionKey: { name: "rateKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(this, "AssetsDeployment", {
      destinationBucket: assetsBucket,
      sources: [s3deploy.Source.asset(assetsPath)],
      prune: true,
    });

    const overlapEnvironment: Record<string, string> = {};
    if (props.config.enrollmentOverlapSecretName)
      Object.assign(overlapEnvironment, {
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: secretJsonRef(
          props.config.enrollmentOverlapSecretName,
          "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID",
        ),
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: secretJsonRef(
          props.config.enrollmentOverlapSecretName,
          "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY",
        ),
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: secretJsonRef(
          props.config.enrollmentOverlapSecretName,
          "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE",
        ),
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: secretJsonRef(
          props.config.enrollmentOverlapSecretName,
          "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER",
        ),
      });
    const enrollmentSigningSecretName =
      props.config.enrollmentSigningSecretName;
    const enrollmentSigningSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "EnrollmentSigningSecret",
      enrollmentSigningSecretName,
    );
    const enrollmentOverlapSecret = props.config.enrollmentOverlapSecretName
      ? secretsmanager.Secret.fromSecretNameV2(
          this,
          "EnrollmentOverlapSecret",
          props.config.enrollmentOverlapSecretName,
        )
      : undefined;

    const server = new lambda.Function(this, "ServerFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(serverPath),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      vpc,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [lambdaSecurityGroup],
      logGroup: new logs.LogGroup(this, "ServerLogGroup", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        NODE_ENV: "production",
        ENGRAM_DEPLOY_ENV: "dev",
        ENGRAM_URL: props.config.engramUrl,
        ENGRAM_COOKIE_DOMAIN: "",
        ENGRAM_RATE_LIMIT_DYNAMODB_TABLE: this.rateLimitTable.tableName,
        DATABASE_URL: `postgresql://${secretArnJsonRef(
          props.config.dbProxyAuthSecretArn,
          "username",
        )}:${secretArnJsonRef(
          props.config.dbProxyAuthSecretArn,
          "password",
        )}@${this.rdsProxy.endpoint}:5432/${props.config.databaseName}?sslmode=require`,
        ENGRAM_JWT_SECRET: secretJsonRef(
          props.config.runtimeSecretName,
          "ENGRAM_JWT_SECRET",
        ),
        ENGRAM_INTERNAL_API_KEY: secretJsonRef(
          props.config.runtimeSecretName,
          "ENGRAM_INTERNAL_API_KEY",
        ),
        ENGRAM_AXON_ENROLLMENT_API_KEY: secretJsonRef(
          props.config.runtimeSecretName,
          "ENGRAM_AXON_ENROLLMENT_API_KEY",
        ),
        ENGRAM_ENROLLMENT_SIGNING_KEY_ID: secretJsonRef(
          enrollmentSigningSecretName,
          "kid",
        ),
        ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY: secretJsonRef(
          enrollmentSigningSecretName,
          "privateKeyPem",
        ),
        ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY: secretJsonRef(
          enrollmentSigningSecretName,
          "publicKeyPem",
        ),
        ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: secretJsonRef(
          enrollmentSigningSecretName,
          "not_before",
        ),
        ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: secretJsonRef(
          enrollmentSigningSecretName,
          "not_after",
        ),
        ...overlapEnvironment,
        ENGRAM_GOOGLE_CLIENT_ID: secretJsonRef(
          props.config.runtimeSecretName,
          "ENGRAM_GOOGLE_CLIENT_ID",
        ),
        ENGRAM_GOOGLE_CLIENT_SECRET: secretJsonRef(
          props.config.runtimeSecretName,
          "ENGRAM_GOOGLE_CLIENT_SECRET",
        ),
        ENGRAM_GITHUB_CLIENT_ID: secretJsonRef(
          props.config.runtimeSecretName,
          "ENGRAM_GITHUB_CLIENT_ID",
        ),
        ENGRAM_GITHUB_CLIENT_SECRET: secretJsonRef(
          props.config.runtimeSecretName,
          "ENGRAM_GITHUB_CLIENT_SECRET",
        ),
        RESEND_API_KEY: secretJsonRef(
          props.config.runtimeSecretName,
          "RESEND_API_KEY",
        ),
        EMAIL_FROM: "Engram <noreply@ctxhost.com>",
        NEXT_PUBLIC_DASHBOARD_URL: props.config.nextPublicDashboardUrl,
        NEXT_PUBLIC_SYNAPSE_URL: props.config.nextPublicSynapseUrl,
        NEXT_PUBLIC_THOUGHTS_URL: props.config.nextPublicThoughtsUrl,
        NEXT_PUBLIC_AXON_URL: props.config.nextPublicAxonUrl,
        NEXT_PUBLIC_PULSE_URL: props.config.nextPublicPulseUrl,
        NEXT_PUBLIC_GYRUS_URL: props.config.nextPublicGyrusUrl,
        NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING: secretJsonRef(
          props.config.runtimeSecretName,
          "NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING",
        ),
      },
    });
    this.rateLimitTable.grantReadWriteData(server);
    enrollmentSigningSecret.grantRead(server);
    enrollmentOverlapSecret?.grantRead(server);
    runtimeSecret.grantRead(server);
    dbProxyAuthSecret.grantRead(server);

    this.functionUrl = server.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    const forwardedHost = new cloudfront.Function(
      this,
      "ForwardedHostFunction",
      {
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.headers["x-forwarded-host"] = request.headers.host;
  return request;
}
`),
      },
    );

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(
          functionUrlDomain(this.functionUrl.url),
          {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          },
        ),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: forwardedHost,
          },
        ],
      },
      additionalBehaviors: {
        "_next/static/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    });

    new cdk.CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
      description: "Throwaway OpenNext spike CloudFront domain.",
    });
    new cdk.CfnOutput(this, "FunctionUrl", {
      value: this.functionUrl.url,
      description: "Throwaway OpenNext spike Lambda function URL.",
    });
    new cdk.CfnOutput(this, "RdsProxyEndpoint", {
      value: this.rdsProxy.endpoint,
      description: "Temporary dev RDS Proxy endpoint used by the spike.",
    });
    new cdk.CfnOutput(this, "RateLimitTableName", {
      value: this.rateLimitTable.tableName,
      description: "DynamoDB table used by the spike shared rate limiter.",
    });
  }
}
