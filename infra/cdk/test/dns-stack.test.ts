import { Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

import { AppStack } from "../lib/app-stack.js";
import { loadConfig } from "../lib/config.js";
import { DnsStack } from "../lib/dns-stack.js";
import { CortexNetworkStack } from "../lib/network-stack.js";

describe("dns stack", () => {
  it("creates Route 53 records for login.ctxhost.com and wildcard tenant routing", () => {
    const app = new cdk.App();
    const config = loadConfig();
    const network = new CortexNetworkStack(app, "NetworkStackForDnsTest", { config });
    const appStack = new AppStack(app, "AppStackForDnsTest", {
      config,
      vpc: network.vpc,
      appSecurityGroup: network.appSecurityGroup,
    });

    const stack = new DnsStack(app, "DnsStackTest", {
      config,
      targetIpAddress: appStack.eip.ref,
      hostedZoneId: "ZTEST123456",
      hostedZoneName: config.rootDomain,
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::Route53::RecordSet", 4);

    const records = template.findResources("AWS::Route53::RecordSet");
    const names = Object.values(records).map(
      (record) => (record as { Properties?: Record<string, unknown> }).Properties?.Name,
    );

    expect(names).toContain("login.dev.ctxhost.com.");
    expect(names).toContain("*.dev.ctxhost.com.");
    expect(names).toContain("login.ctxhost.com.");
    expect(names).toContain("*.ctxhost.com.");

    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "login.dev.ctxhost.com.",
      Type: "A",
      HostedZoneId: "ZTEST123456",
      TTL: "300",
    });
  });
});
