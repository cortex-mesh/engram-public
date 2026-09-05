import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../lib/config.js";
import { CortexNetworkStack } from "../lib/network-stack.js";

describe("network stack", () => {
  it("creates a VPC with public and isolated private subnets, app/db security groups, and no NAT gateway", () => {
    const app = new cdk.App();
    const stack = new CortexNetworkStack(app, "NetworkStackTest", {
      config: loadConfig(),
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::EC2::VPC", 1);
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::SecurityGroup", 2);

    const subnets = template.findResources("AWS::EC2::Subnet");
    expect(Object.keys(subnets)).toHaveLength(4);

    const values = Object.values(subnets) as Array<{ Properties?: Record<string, unknown> }>;
    const publicSubnetCount = values.filter(
      (subnet) => subnet.Properties?.MapPublicIpOnLaunch === true,
    ).length;
    const privateSubnetCount = values.filter(
      (subnet) => subnet.Properties?.MapPublicIpOnLaunch !== true,
    ).length;

    expect(publicSubnetCount).toBe(2);
    expect(privateSubnetCount).toBe(2);

    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          FromPort: 80,
          ToPort: 80,
          IpProtocol: "tcp",
          CidrIp: "0.0.0.0/0",
        }),
        Match.objectLike({
          FromPort: 443,
          ToPort: 443,
          IpProtocol: "tcp",
          CidrIp: "0.0.0.0/0",
        }),
      ]),
    });

    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      FromPort: 5432,
      ToPort: 5432,
      IpProtocol: "tcp",
    });
  });
});
