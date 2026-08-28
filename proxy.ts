import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readTokenValue } from "@/lib/auth/session";

/**
 * Optimistic route gating. Next 16 renamed middleware to `proxy`.
 *
 * This exists so a signed-out person lands on the sign-in page instead of a
 * flash of empty admin chrome. It is NOT the authorization boundary — Next's own
 * guidance is that proxy should not be used for session management, and Server
 * Actions are reachable by direct POST regardless of what this allows.
 *
 * `requireUser()` in lib/auth/guard.ts is the real check, and it runs on every
 * page and every action. If this file were deleted the app would still be
 * secure; it would just be uglier.
 */
export function proxy(request: NextRequest) {
  const claims = readTokenValue(request.cookies.get(SESSION_COOKIE)?.value);

  if (!claims) {
    const url = new URL("/signin", request.url);
    // Bring them back where they were heading once they sign in.
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Only the admin surface. The public API authenticates with its own API keys,
  // the webhook with Meta's signature, and /signin must stay reachable.
  matcher: ["/admin/:path*"],
};
