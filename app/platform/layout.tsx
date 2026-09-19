import Link from "next/link";
import { currentOperator } from "@/lib/platform/guard";
import { readTheme } from "@/lib/theme";
import { ThemeToggle } from "@/app/ThemeToggle";
import { SideNav, type NavSection } from "@/app/SideNav";
import { Icon } from "@/app/icons";
import { Lockup } from "@/app/Wordmark";
import { platformSignOut } from "./actions";

/**
 * Operator console shell.
 *
 * Everything below this chrome is another company's operational data, and the
 * single most likely mistake here is forgetting which console you are in. That
 * used to be said with paint — the whole shell was near-black where the tenant
 * admin was blue.
 *
 * It is said with words and one semantic hue now, because the interface has one
 * palette and repainting the chrome per surface is exactly the "a lot of colour
 * spent on something people navigate past" the reference argues against. What
 * replaces it is louder about the actual risk: a strip across the top of every
 * page that names the console and what it can see, in the warning hue, plus a
 * sidebar that says "console" under the logotype. Neither can be mistaken for a
 * tenant admin, and unlike a colour, both survive greyscale.
 *
 * The layout does NOT call requireOperator(): /platform/signin renders inside
 * it, and guarding here would redirect the sign-in page to itself. Each page
 * guards itself, which is where the check belongs anyway.
 */

const NAV: NavSection[] = [
  { items: [{ href: "/platform", label: "Every business", exact: true }] },
];

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const operator = await currentOperator();
  const theme = await readTheme();

  // No operator means this is the sign-in page — render it bare rather than
  // wrapping it in chrome that names somebody who isn't signed in.
  if (!operator) return <>{children}</>;

  return (
    <div className="flex min-h-screen flex-col bg-paper md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-rule bg-surface md:sticky md:top-0 md:h-screen md:w-[184px] md:border-b-0 md:border-r">
        <Link href="/platform" className="flex items-center gap-2 px-3 py-3.5">
          <Lockup size={20} />
          <span className="font-display text-[15px] font-semibold tracking-tight text-ink-faint">
            / console
          </span>
        </Link>

        <SideNav sections={NAV} />

        <div className="mt-auto flex flex-col gap-2 border-t border-rule px-3 py-2.5">
          <span className="truncate text-[11px] text-ink-faint" title={operator.email}>
            {operator.email} · {operator.role}
          </span>
          <form action={platformSignOut}>
            <button type="submit" className="btn btn-ghost">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {/* Above the content on every page, not just the first one. Whoever is
            reading this arrived by a deep link as often as not. */}
        <div className="notice notice-warn flex items-center gap-2 rounded-none border-x-0 border-t-0 px-4 py-1.5">
          <Icon name="alert" size={13} className="shrink-0" />
          <span className="font-semibold">Operator console</span>
          <span className="opacity-80">· every business on the platform</span>

          {/* Top right of the screen, like everywhere else. It sits IN the strip
              rather than floating over it — this bar is the first thing on the
              page, and a control laid on top of a warning is a control that
              obscures one. */}
          <div className="ml-auto">
            <ThemeToggle initial={theme} />
          </div>
        </div>

        <div className="mx-auto w-full max-w-[1150px] px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
