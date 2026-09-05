// AWS Secrets Manager abstraction for per-org provider credentials (ADR-021).
// Callers always go through these three functions; tests mock this module.
// Real provisioning is Roland's gate (D2); AWS_REGION gates all live calls.
// If AWS_REGION is unset (dev/CI), writes/deletes warn and return; reads throw.

import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
  ResourceExistsException,
} from "@aws-sdk/client-secrets-manager";

// Module-level singleton so the SDK reuses connection pools and credential cache
// across requests. Recreated only if AWS_REGION changes (which never happens in
// practice — it's set at container start and doesn't change at runtime).
let _client: SecretsManagerClient | null = null;
let _clientRegion: string | undefined;

function getSmClient(): SecretsManagerClient | null {
  const region = process.env.AWS_REGION;
  if (!region) return null;
  if (!_client || _clientRegion !== region) {
    _client = new SecretsManagerClient({ region });
    _clientRegion = region;
  }
  return _client;
}

export async function writeProviderSecret(secretId: string, value: string): Promise<void> {
  const client = getSmClient();
  if (!client) {
    console.warn("[engram][asm] AWS_REGION not set — skipping ASM write for", secretId);
    return;
  }
  try {
    await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      // Secret does not exist yet — create it. Handle the race where a concurrent
      // PUT already created it between our Put and our Create by falling back to
      // another Put (which is always safe and idempotent).
      try {
        await client.send(new CreateSecretCommand({ Name: secretId, SecretString: value }));
      } catch (createErr) {
        if (createErr instanceof ResourceExistsException) {
          await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
        } else {
          throw createErr;
        }
      }
    } else {
      throw err;
    }
  }
}

export async function readProviderSecret(secretId: string): Promise<string> {
  const client = getSmClient();
  if (!client) {
    throw new Error(`ASM not configured (AWS_REGION unset) — cannot read secret ${secretId}`);
  }
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) {
    throw new Error(`Secret ${secretId} has no string value`);
  }
  return result.SecretString;
}

/**
 * Read the dedicated Cite enrollment signing secret.
 *
 * Separate from `readProviderSecret` on purpose: that one serves ADR-021
 * per-org provider credentials, a different secret namespace with different
 * IAM and a different lifecycle. Sharing the function would make one
 * IAM/behaviour change silently move both boundaries, which is the same
 * coupling ADR-034 §2 rejects for credentials.
 *
 * Callers must treat a throw as fail-closed: the enrollment surface answers
 * 503 and the consumer denies (ADR-034 §4).
 */
export async function readEnrollmentSigningSecret(secretId: string): Promise<string> {
  const client = getSmClient();
  if (!client) {
    throw new Error(
      `ASM not configured (AWS_REGION unset) — cannot read enrollment signing secret ${secretId}`,
    );
  }
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) {
    throw new Error(`Enrollment signing secret ${secretId} has no string value`);
  }
  return result.SecretString;
}

export async function deleteProviderSecret(secretId: string): Promise<void> {
  const client = getSmClient();
  if (!client) {
    console.warn("[engram][asm] AWS_REGION not set — skipping ASM delete for", secretId);
    return;
  }
  await client.send(
    new DeleteSecretCommand({ SecretId: secretId, ForceDeleteWithoutRecovery: true }),
  );
}
