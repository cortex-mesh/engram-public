#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { AppStack } from "../lib/app-stack.js";
import { getStackNames, loadConfig } from "../lib/config.js";
import { DataStack } from "../lib/data-stack.js";
import { DnsStack } from "../lib/dns-stack.js";
import { CortexNetworkStack } from "../lib/network-stack.js";
import {
  addAppOutputs,
  addDataOutputs,
  addDnsOutputs,
  addNetworkOutputs,
} from "../lib/outputs.js";
import {
  addEngramProdStacks,
  loadProdStackConfigFromEnv,
} from "../lib/prod-stacks.js";
import { EngramSpikeStack, loadSpikeStackConfigFromEnv } from "../lib/spike-stack.js";

const app = new cdk.App();
const config = loadConfig();
const names = getStackNames(config);
const env = {
  region: config.region,
  account: process.env.CDK_DEFAULT_ACCOUNT,
};
const hostedZoneId = config.hostedZoneId;

const network = new CortexNetworkStack(app, names.network, {
  config,
  env,
});
addNetworkOutputs(network);

const data = new DataStack(app, names.data, {
  config,
  env,
  vpc: network.vpc,
  dbSecurityGroup: network.dbSecurityGroup,
  stackName: names.data,
});
addDataOutputs(data);

const appStack = new AppStack(app, names.app, {
  config,
  env,
  vpc: network.vpc,
  appSecurityGroup: network.appSecurityGroup,
  stackName: names.app,
});
addAppOutputs(appStack);

if (hostedZoneId) {
  const dns = new DnsStack(app, names.dns, {
    config,
    env,
    hostedZoneId,
    hostedZoneName: config.rootDomain,
    targetIpAddress: appStack.eip.ref,
    stackName: names.dns,
  });
  dns.addDependency(appStack);
  addDnsOutputs(dns);
}

if (process.env.ENGRAM_ENABLE_SPIKE_STACK === "1") {
  new EngramSpikeStack(app, "engram-spike", {
    config: loadSpikeStackConfigFromEnv(),
    env,
    stackName: "engram-spike",
  });
}

if (process.env.ENGRAM_ENABLE_PROD_STACKS === "1") {
  addEngramProdStacks(app, loadProdStackConfigFromEnv(), env);
}
