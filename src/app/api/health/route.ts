import { NextResponse } from "next/server";
import pkg from "../../../../package.json";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "engram",
    version: pkg.version,
  });
}
