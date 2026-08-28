import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/guard";
import { signIn } from "./actions";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  // Already signed in — don't show a form they don't need.
  if (await currentUser()) redirect("/admin");

  const { error, next } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-3">
            cadence
          </span>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">Sign in</h1>
        </div>

        <form action={signIn} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next ?? "/admin"} />

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Email
            </span>
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              className="rounded-md border border-rule bg-surface px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
            />
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
              className="rounded-md border border-rule bg-surface px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
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
