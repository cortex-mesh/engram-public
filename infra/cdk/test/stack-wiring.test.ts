import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AppStack } from "../lib/app-stack.js";
import { loadConfig } from "../lib/config.js";
import { DataStack } from "../lib/data-stack.js";
import { DnsStack } from "../lib/dns-stack.js";
import { CortexNetworkStack } from "../lib/network-stack.js";
import { addAppOutputs, addDataOutputs } from "../lib/outputs.js";

describe("stack wiring", () => {
  it("wires network, data, app, and dns stacks together and exposes key outputs", () => {
    const app = new cdk.App();
    const config = loadConfig();

    const network = new CortexNetworkStack(app, "NetworkStackWiringTest", { config });
    const data = new DataStack(app, "DataStackWiringTest", {
      config,
      vpc: network.vpc,
      dbSecurityGroup: network.dbSecurityGroup,
    });
    const appStack = new AppStack(app, "AppStackWiringTest", {
      config,
      vpc: network.vpc,
      appSecurityGroup: network.appSecurityGroup,
    });
    const dns = new DnsStack(app, "DnsStackWiringTest", {
      config,
      hostedZoneId: "ZTEST123456",
      hostedZoneName: config.rootDomain,
      targetIpAddress: appStack.eip.ref,
    });

    addDataOutputs(data);
    addAppOutputs(appStack);

    expect(app.node.findChild("NetworkStackWiringTest")).toBe(network);
    expect(app.node.findChild("DataStackWiringTest")).toBe(data);
    expect(app.node.findChild("AppStackWiringTest")).toBe(appStack);
    expect(app.node.findChild("DnsStackWiringTest")).toBe(dns);

    const appTemplate = Template.fromStack(appStack);
    const dataTemplate = Template.fromStack(data);

    expect(Object.keys(appTemplate.findOutputs("*"))).not.toHaveLength(0);
    expect(Object.keys(dataTemplate.findOutputs("*"))).not.toHaveLength(0);
  });
});
