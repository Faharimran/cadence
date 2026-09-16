import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/guard";
import { readTheme } from "@/lib/theme";
import { ThemeCorner } from "@/app/ThemeToggle";
import { env } from "@/lib/env";
import { signIn } from "./actions";

export const dynamic = "force-dynamic";

const signupOpen = env.CADENCE_SIGNUP_OPEN === "true";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  // Already signed in — don't show a form they don't need.
  if (await currentUser()) redirect("/admin");

  const { error, next } = await searchParams;
  const theme = await readTheme();

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <ThemeCorner initial={theme} />
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col gap-1">
          <span className="eyebrow">
            cadence
          </span>
          <h1 className="num text-[22px] font-semibold">Sign in</h1>
        </div>

        <form action={signIn} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next ?? "/admin"} />

          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">
              Email
            </span>
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              className="input"
            />
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
              className="input"
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

        {signupOpen && (
          <p className="mt-8 text-sm text-ink-2">
            No account yet?{" "}
            <Link href="/signup" className="text-accent underline underline-offset-2">
              Set up your business
            </Link>
            .
          </p>
        )}
      </div>
    </main>
  );
}
