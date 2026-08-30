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
    <div className="flex min-h-screen flex-col">
      <div
        className="px-6 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.16em]"
        style={{ background: "var(--warn)", color: "#1a1200" }}
      >
        Operator console · every business on the platform
      </div>

      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/platform" className="font-mono text-sm font-semibold tracking-tight">
            cadence <span className="text-ink-3">/ console</span>
          </Link>

          <div className="ml-auto flex items-center gap-4">
            <span className="font-mono text-[11px] text-ink-3">
              {operator.email} · {operator.role}
            </span>
            <form action={platformSignOut}>
              <button
                type="submit"
                className="font-mono text-[11px] text-ink-2 underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
