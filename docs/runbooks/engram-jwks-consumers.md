# Engram JWKS Consumer Verification

Engram production signs access and refresh tokens with RS256. Consumers verify access tokens with Engram's public JWKS and must never receive or store the private signing key.

## Endpoint

Production JWKS:

```text
https://login.ctxhost.com/.well-known/jwks.json
```

The endpoint returns public signing keys only. It includes `kid`, `alg`, and `use` so consumers can select the matching key from the JWT protected header.

## Verification Contract

Consumers must verify:

- `alg` is `RS256`
- issuer is `engram`
- the token `type` claim is `access`
- the signature validates against the JWKS key matching the token `kid`
- normal expiration validation succeeds

Do not accept HS256 tokens from Engram production. HS256 remains the dev/local compatibility mode until the suite-wide migration is separately planned.

## Example

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(
  new URL("https://login.ctxhost.com/.well-known/jwks.json"),
);

export async function verifyEngramAccessToken(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "engram",
    algorithms: ["RS256"],
  });
  if (payload.type !== "access") {
    throw new Error("Expected an Engram access token");
  }
  return payload;
}
```

Cache JWKS according to normal HTTP cache semantics. During key rotation, Engram publishes the active public key with a new `kid`; consumers select by the token header.
