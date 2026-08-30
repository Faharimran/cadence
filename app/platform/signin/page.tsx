import { redirect } from "next/navigation";
import { currentOperator } from "@/lib/platform/guard";
import { platformSignIn } from "../actions";

export const dynamic = "force-dynamic";

const field =
  "rounded-md border border-rule bg-surface px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

/**
 * Visually distinct from the tenant sign-in on purpose.
 *
 * Two near-identical login screens on one domain is how someone types their
 * operator password into a customer's admin. The label says which door this is.
 */
export default async function PlatformSignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentOperator()) redirect("/platform");
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-3">
            cadence · operators
          </span>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">Console</h1>
          <p className="mt-2 text-sm text-ink-2">
            For the people who run cadence. If you run a business on it,{" "}
            <a href="/signin" className="text-accent underline underline-offset-2">
              sign in here
            </a>
            .
          </p>
        </div>

        <form action={platformSignIn} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Email
            </span>
            <input name="email" type="email" autoComplete="username" required autoFocus className={field} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Password
            </span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={field}
            />
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-bad/40 px-3 py-2 text-sm"
              style={{ color: "var(--bad)" }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            className="mt-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
