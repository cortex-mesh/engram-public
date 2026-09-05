# Namecheap → Route 53 delegation for ctxhost.com

## Route 53 hosted zone created

- Hosted zone ID: `Z099959326CYRBW3F5PTA`
- Domain: `ctxhost.com`

## Route 53 nameservers

Set these four nameservers at Namecheap for `ctxhost.com`:

- `ns-661.awsdns-18.net`
- `ns-1436.awsdns-51.org`
- `ns-1850.awsdns-39.co.uk`
- `ns-306.awsdns-38.com`

## Namecheap steps

1. Log in to Namecheap
2. Open the domain manager for `ctxhost.com`
3. Go to the domain nameserver settings
4. Choose `Custom DNS`
5. Replace the current nameservers with the four Route 53 nameservers above
6. Save changes

## Notes

- DNS propagation may take some time after changing nameservers.
- Once delegation is live, Route 53 becomes authoritative for `ctxhost.com`.
- Delegation is now confirmed live as of 2026-04-22 by both AWS Route 53 and public resolvers (`1.1.1.1`, `8.8.8.8`).
- After propagation, the CDK DNS stack can manage:
  - `login.ctxhost.com`
  - `*.ctxhost.com`

## Verification

After changing nameservers, verify with:

```bash
dig NS ctxhost.com
dig @1.1.1.1 +short NS ctxhost.com
dig @8.8.8.8 +short NS ctxhost.com
```

Expected result:
- the four AWS nameservers above

## Confirmed current state

As of 2026-04-22, delegation is confirmed live:

- Route 53 hosted zone `Z099959326CYRBW3F5PTA` exists in the `cortex` AWS account
- AWS reports the delegation set as:
  - `ns-661.awsdns-18.net`
  - `ns-1436.awsdns-51.org`
  - `ns-1850.awsdns-39.co.uk`
  - `ns-306.awsdns-38.com`
- public resolvers `1.1.1.1` and `8.8.8.8` both return those same nameservers for `ctxhost.com`

That means Route 53 is authoritative for `ctxhost.com`, and registrar delegation is no longer a blocker for AWS DNS work.
