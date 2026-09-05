import { NextResponse } from "next/server";

import { getPublicJwks } from "@/lib/jwt";

export async function GET() {
  const response = NextResponse.json(await getPublicJwks());
  response.headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
  return response;
}
