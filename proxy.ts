import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readTokenValue } from "@/lib/auth/session";
import { PLATFORM_COOKIE, readPlatformTokenValue } from "@/lib/platform/session";

/**
 * Optimistic route gating. Next 16 renamed middleware to `proxy`.
 *
 * This exists so a signed-out person lands on the sign-in page instead of a
 * flash of empty admin chrome. It is NOT the authorization boundary — Next's own
 * guidance is that proxy should not be used for session management, and Server
 * Actions are reachable by direct POST regardless of what this allows.
 *
 * `requireUser()` and `requireOperator()` are the real checks, and they run on
 * every page and every action. If this file were deleted the app would still be
 * secure; it would just be uglier.
 *
 * The two surfaces are checked against their OWN cookie. A tenant session must
 * not open the operator console and an operator session must not open a tenant
 * admin — and since neither token verifies under the other's HMAC domain, the
 * separation holds even if this file confused them.
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (path.startsWith("/platform")) {
    // The sign-in page must stay reachable to someone with no session at all.
    if (path === "/platform/signin") return NextResponse.next();

    const operator = readPlatformTokenValue(request.cookies.get(PLATFORM_COOKIE)?.value);
    if (!operator) {
      return NextResponse.redirect(new URL("/platform/signin", request.url));
    }
    return NextResponse.next();
  }

  const claims = readTokenValue(request.cookies.get(SESSION_COOKIE)?.value);
  if (!claims) {
    const url = new URL("/signin", request.url);
    // Bring them back where they were heading once they sign in.
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // The two authenticated surfaces. The public API authenticates with its own
  // API keys, the webhook with Meta's signature, and /, /signin and /signup must
  // stay reachable.
  matcher: ["/admin/:path*", "/platform/:path*"],
};
