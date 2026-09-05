import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

import { getSharedDnsRecordNames } from "./config.js";
import type { StackPropsWithConfig } from "./types.js";

export interface DnsStackProps extends StackPropsWithConfig {
  hostedZoneId: string;
  hostedZoneName: string;
  targetIpAddress: string;
}

export class DnsStack extends cdk.Stack {
  readonly hostedZoneName: string;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    this.hostedZoneName = props.hostedZoneName;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    const records = getSharedDnsRecordNames(props.config);

    for (const recordName of [
      records.devLogin,
      records.devWildcard,
      records.prodLogin,
      records.prodWildcard,
    ]) {
      new route53.ARecord(this, `Record${recordName.replace(/[^A-Za-z0-9]/g, "")}`, {
        zone,
        recordName,
        ttl: cdk.Duration.minutes(5),
        target: route53.RecordTarget.fromIpAddresses(props.targetIpAddress),
      });
    }
  }
}
