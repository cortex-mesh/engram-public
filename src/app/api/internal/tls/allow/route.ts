import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { isLoopbackRequestHost, parseTenantTlsDomain } from "@/lib/tenant-tls";

export const dynamic = "force-dynamic";

function deny() {
  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: NextRequest) {
  if (!isLoopbackRequestHost(request.headers.get("host"))) {
    return deny();
  }

  const tenantDomain = parseTenantTlsDomain(request.nextUrl.searchParams.get("domain"));
  if (!tenantDomain) {
    return deny();
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: tenantDomain.slug },
    select: { id: true },
  });

  if (!organization) {
    return deny();
  }

  return NextResponse.json(
    {
      allowed: true,
      hostname: tenantDomain.hostname,
      slug: tenantDomain.slug,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
