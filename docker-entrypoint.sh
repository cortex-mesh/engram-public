#!/bin/sh
set -e

# Allow one-shot deploy hooks to run commands such as:
#   docker run ... engram-engram npx prisma migrate deploy
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# The enrollment authority is fail-closed at its own internal endpoints. It is
# deliberately not a liveness dependency for the shared IdP: an expired Cite
# key must never prevent Tradepost or FieldOps from issuing tokens.
#
exec node server.js
