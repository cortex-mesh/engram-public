import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { StackPropsWithConfig } from "./types.js";

export interface AppStackProps extends StackPropsWithConfig {
  vpc: ec2.IVpc;
  appSecurityGroup: ec2.ISecurityGroup;
}

export class AppStack extends cdk.Stack {
  readonly instance: ec2.Instance;
  readonly eip: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, "AppHostRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"),
      ],
    });

    const stack = cdk.Stack.of(this);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [
          stack.formatArn({
            service: "secretsmanager",
            resource: "secret",
            resourceName: `cortex${props.config.deploymentEnvironment}data*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
          stack.formatArn({
            service: "secretsmanager",
            resource: "secret",
            resourceName: `engram-${props.config.deploymentEnvironment}-*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    const userDataPath = join(import.meta.dirname, "..", "assets", "user-data", "bootstrap.sh");
    const userDataScript = readFileSync(userDataPath, "utf8");

    this.instance = new ec2.Instance(this, "AppHost", {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: props.appSecurityGroup,
      role,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      instanceType: new ec2.InstanceType(props.config.instanceType),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(props.config.appVolumeSizeGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    this.eip = new ec2.CfnEIP(this, "AppHostEip", {
      domain: "vpc",
    });

    new ec2.CfnEIPAssociation(this, "AppHostEipAssociation", {
      allocationId: this.eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    this.instance.addUserData(userDataScript);
  }
}
