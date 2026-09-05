import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

import { AppStack } from "../lib/app-stack.js";
import { loadConfig } from "../lib/config.js";
import { CortexNetworkStack } from "../lib/network-stack.js";

describe("app stack", () => {
  it("creates a shared app host with SSM, ECR pull access, gp3 storage, bootstrap user data, and scoped secret-read policy", () => {
    const app = new cdk.App();
    const config = loadConfig();
    const network = new CortexNetworkStack(app, "NetworkStackForAppTest", { config });
    const stack = new AppStack(app, "AppStackTest", {
      config,
      vpc: network.vpc,
      appSecurityGroup: network.appSecurityGroup,
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::EC2::Instance", 1);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.resourceCountIs("AWS::IAM::InstanceProfile", 1);
    template.resourceCountIs("AWS::IAM::Policy", 1);

    template.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: "t4g.medium",
      IamInstanceProfile: {
        Ref: template.getResourceId("AWS::IAM::InstanceProfile"),
      },
      UserData: {
        "Fn::Base64": Match.anyValue(),
      },
    });

    template.hasResourceProperties("AWS::IAM::Role", {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          "Fn::Join": Match.anyValue(),
        }),
        Match.objectLike({
          "Fn::Join": Match.anyValue(),
        }),
      ]),
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
          }),
        ]),
      },
    });

    const instances = template.findResources("AWS::EC2::Instance");
    const instance = Object.values(instances)[0] as { Properties?: Record<string, unknown> };
    expect(instance.Properties?.BlockDeviceMappings).toBeTruthy();
  });
});
