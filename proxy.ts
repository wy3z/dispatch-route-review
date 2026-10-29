import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  resolveAuthMode,
  trustedIdentityFromHeaders,
} from "@/modules/access/domain";

export function proxy(request: NextRequest) {
  const authMode = resolveAuthMode();
  if (authMode === "invalid") {
    return NextResponse.json(
      { message: "Authentication is not configured." },
      { status: 503 },
    );
  }
  if (authMode === "development") {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname === "/logout/entra") {
    return NextResponse.next();
  }
  if (!trustedIdentityFromHeaders(request.headers)) {
    return NextResponse.json(
      { message: "Authentication is required." },
      { status: 401 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|icon\\.svg$|api/health/(?:live|ready)$).*)",
  ],
};
