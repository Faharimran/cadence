import Link from "next/link";
import { currentOperator } from "@/lib/platform/guard";
import { platformSignOut } from "./actions";

/**
 * Operator console shell.
 *
 * The banner is not decoration. Everything below it is another company's
 * operational data, and the single most likely mistake here is forgetting which
 * console you are in — so the chrome says so, in a colour the tenant admin never
 * uses.
 *
 * The layout does NOT call requireOperator(): /platform/signin renders inside
 * it, and guarding here would redirect the sign-in page to itself. Each page
 * guards itself, which is where the check belongs anyway.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const operator = await currentOperator();

  // No operator means this is the sign-in page — render it bare rather than
  // wrapping it in chrome that names somebody who isn't signed in.
  if (!operator) return <>{children}</>;

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      {/* Near-black rather than the admin's blue, and the same shape. Someone
          who can open both surfaces should know which one they are looking at
          from the colour alone, before reading a word of it. */}
      <header className="bg-console text-on-shell">
        <div
          className="px-6 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.16em]"
          style={{ background: "var(--warn)", color: "#1a1200" }}
        >
          Operator console · every business on the platform
        </div>

        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
          <Link href="/platform" className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="grid size-7 place-items-center rounded-lg text-[12px] font-bold"
              style={{ background: "var(--warn)", color: "#1a1200" }}
            >
              c
            </span>
            <span className="font-display text-[15px] font-semibold tracking-tight">
              cadence <span className="text-on-shell-2">/ console</span>
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-4">
            <span className="hidden font-mono text-[11px] text-on-shell-2 sm:inline">
              {operator.email} · {operator.role}
            </span>
            <form action={platformSignOut}>
              <button
                type="submit"
                className="rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto -mt-3 w-full max-w-6xl flex-1 rounded-t-2xl bg-paper px-6 py-8 sm:px-8">
        {children}
      </main>
    </div>
  );
}
