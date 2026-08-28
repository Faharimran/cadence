import { redirect } from "next/navigation";

/**
 * The root is just a doorway.
 *
 * This used to render an operator console listing every tenant — useful while
 * developing, but it read platform-wide state on the admin connection, which
 * row-level security deliberately does not protect. A page that enumerates every
 * customer is precisely what tenant isolation exists to prevent, and gating it
 * behind a `NODE_ENV` check is a flag, not a guard.
 *
 * Deleted rather than gated. Liveness lives at /api/health; the API surface is
 * documented in the README.
 */
export default function Root() {
  // proxy.ts sends anyone without a session on to /signin.
  redirect("/admin");
}
