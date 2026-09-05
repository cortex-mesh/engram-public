import { NextRequest, NextResponse } from "next/server";

import {
  extractRequestedClientIds,
  getPublicAuthClientConfig,
} from "@/lib/auth-client-config";
import { resolveAuthClientForRequest } from "@/lib/auth-host-client";

export async function GET(request: NextRequest) {
  const resolution = resolveAuthClientForRequest(
    extractRequestedClientIds(request.nextUrl.searchParams),
    request.headers,
  );
  if (resolution.rejected) {
    return NextResponse.json({ error: "client_id is not allowed on this auth host." }, { status: 400 });
  }
  const config = await getPublicAuthClientConfig(resolution.clientId);
  return NextResponse.json(config);
}
