import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/guard";
import { readTheme } from "@/lib/theme";
import { ThemeCorner } from "@/app/ThemeToggle";
import { Icon } from "@/app/icons";
import { Lockup } from "@/app/Wordmark";
import { env } from "@/lib/env";
import { signIn } from "./actions";

export const dynamic = "force-dynamic";

const signupOpen = env.CADENCE_SIGNUP_OPEN === "true";

/**
 * Two halves of the window: what is behind the door, and the door.
 *
 * The left half is the only gradient in the product. It earns the exception
 * because this is the one screen someone sees before they have any reason to
 * trust the thing — the admin has work to do and should get out of the way, and
 * a brand surface should not.
 *
 * What it says is the product's own three claims, in the words the marketing
 * page already uses. A sign-in page is a bad place to start writing new
 * promises: whatever is written here is the first thing a customer reads and
 * the last thing anybody remembers to keep true.
 *
 * Deliberately absent: a "continue with Google" button. enori has no Google
 * sign-in, and a button that looks the part and does nothing is worse than no
 * button at all.
 */
const CLAIMS = [
  { title: "It answers", body: "From what you wrote down, and only that." },
  { title: "It books", body: "Against live availability, never a cached copy." },
  { title: "It hands over", body: "The moment a question crosses a line you drew." },
];

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
    // Full bleed rather than a card on a page: this is the only screen with
    // nothing else on it, so the brand half may as well be the size it wants.
    <main className="grid min-h-screen md:grid-cols-[1.05fr_1fr]">
      <ThemeCorner initial={theme} />

      {/* ── What is behind the door ────────────────────────────────── */}
      {/* Hidden on a phone rather than stacked: a tall gradient above a form is
          decoration in the way, and the form is what they came for. */}
      <aside className="auth-band relative hidden flex-col justify-center p-10 md:flex lg:p-14">
        {/* Out of the flow, so the copy below centres against the panel rather
            than against whatever is left under the mark. */}
        <div className="absolute left-10 top-10 lg:left-14 lg:top-14">
          <Lockup size={26} tone="solid" />
        </div>

        {/* Held to a measure. A headline that runs the width of a half-window is
            one nobody finishes the first line of. */}
        <div className="max-w-[620px] py-16">
          <span className="auth-badge">
            <Icon name="check" size={12} />
            Only what you approved
          </span>
          <h2 className="mt-5 font-display text-[34px] font-semibold leading-[1.1] tracking-[-0.02em] lg:text-[42px]">
            Your assistant answers.
            <br />
            You approve every word.
          </h2>
          <p className="mt-4 max-w-[46ch] text-[15px] leading-relaxed text-white/85">
            It replies to your customers on WhatsApp, books into your real calendar, and hands over
            anything you haven&apos;t approved it to say.
          </p>

          <ul className="mt-9 grid max-w-[620px] gap-3 sm:grid-cols-3">
            {CLAIMS.map((claim, i) => (
              <li key={claim.title} className={`auth-tile ${i === 0 ? "auth-tile-lead" : ""}`}>
                <p className="text-[14px] font-semibold">{claim.title}</p>
                <p
                  className={`mt-1.5 text-[12.5px] leading-snug ${
                    i === 0 ? "text-ink-2" : "text-white/80"
                  }`}
                >
                  {claim.body}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* ── The door ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-[400px]">
          {/* The mark again, for the phone, where the panel is not shown. */}
          <div className="mb-8 md:hidden">
            <Lockup size={24} />
          </div>

          <h1 className="text-center text-[27px] font-semibold tracking-[-0.015em]">Welcome back</h1>
          <p className="mt-2 mb-8 text-center text-[14px] text-ink-2">Sign in to your business.</p>

          <form action={signIn} className="flex flex-col gap-5">
            <input type="hidden" name="next" value={next ?? "/admin"} />

            <label className="flex flex-col gap-1.5">
              <span className="label-lg">Email</span>
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                placeholder="you@yourbusiness.com"
                className="input input-lg"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="label-lg">Password</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="input input-lg"
              />
            </label>

            {error && (
              <div className="notice notice-bad flex items-start gap-2" role="alert">
                <Icon name="cross" size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn btn-primary btn-block btn-lg mt-2">
              Continue
            </button>
          </form>

          {signupOpen && (
            <p className="mt-7 text-center text-[14px] text-ink-2">
              No account yet?{" "}
              <Link href="/signup" className="font-medium text-accent underline underline-offset-2">
                Set up your business
              </Link>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
