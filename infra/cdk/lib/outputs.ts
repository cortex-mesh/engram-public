import * as cdk from "aws-cdk-lib";

import type { AppStack } from "./app-stack.js";
import type { DataStack } from "./data-stack.js";
import type { DnsStack } from "./dns-stack.js";
import type { CortexNetworkStack } from "./network-stack.js";

export function addNetworkOutputs(stack: CortexNetworkStack): void {
  new cdk.CfnOutput(stack, "VpcId", {
    value: stack.vpc.vpcId,
    description: "VPC ID for the shared Cortex infrastructure.",
  });
}

export function addDataOutputs(stack: DataStack): void {
  new cdk.CfnOutput(stack, "DatabaseEndpointAddress", {
    value: stack.database.instanceEndpoint.hostname,
    description: "RDS endpoint hostname for the shared environment data plane.",
  });

  if (stack.database.secret) {
    new cdk.CfnOutput(stack, "DatabaseSecretArn", {
      value: stack.database.secret.secretArn,
      description: "Secrets Manager ARN for the shared environment provisioning credentials.",
    });
  }
}

export function addAppOutputs(stack: AppStack): void {
  new cdk.CfnOutput(stack, "AppHostInstanceId", {
    value: stack.instance.instanceId,
    description: "EC2 instance ID for the application host.",
  });

  new cdk.CfnOutput(stack, "AppHostElasticIp", {
    value: stack.eip.ref,
    description: "Elastic IP allocated to the application host.",
  });
}

export function addDnsOutputs(stack: DnsStack): void {
  new cdk.CfnOutput(stack, "HostedZoneName", {
    value: stack.hostedZoneName,
    description: "Hosted zone name used for public records.",
  });
}
