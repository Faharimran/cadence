import { redirect } from "next/navigation";
import { currentOperator } from "@/lib/platform/guard";
import { readTheme } from "@/lib/theme";
import { ThemeCorner } from "@/app/ThemeToggle";
import { platformSignIn } from "../actions";

export const dynamic = "force-dynamic";

const field =
  "input";

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
  const theme = await readTheme();

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <ThemeCorner initial={theme} />
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col gap-1">
          <span className="eyebrow">
            cadence · operators
          </span>
          <h1 className="num text-[22px] font-semibold">Console</h1>
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
            <span className="eyebrow">
              Email
            </span>
            <input name="email" type="email" autoComplete="username" required autoFocus className={field} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">
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
              className="txt-bad rounded-md border border-bad/40 px-3 py-2 text-sm"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary mt-1"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
