import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { readTheme } from "@/lib/theme";
import { signOut } from "@/app/signin/actions";
import { ThemeCorner } from "@/app/ThemeToggle";
import { SideNav, type NavSection } from "@/app/SideNav";
import { Lockup } from "@/app/Wordmark";

/**
 * Admin shell.
 *
 * `requireUser()` here is not decoration — a layout runs for every page beneath
 * it, so this is the second line of defence after proxy.ts. Each page and action
 * still calls it independently, because a layout guard alone would not protect a
 * Server Action invoked by direct POST.
 *
 * The shape is a narrow light column beside a working area, and the column is
 * sectioned. It replaced a coloured band with ten pills in a row, which had two
 * problems a sidebar does not: the row was one destination away from wrapping
 * onto a second line at any moment, and ten equally weighted labels tell you
 * nothing about which of them you want.
 */

const NAV: NavSection[] = [
  {
    items: [
      { href: "/admin", label: "Today", exact: true },
      { href: "/admin/conversations", label: "Conversations" },
      { href: "/admin/bookings", label: "Bookings" },
      { href: "/admin/performance", label: "How you're doing" },
    ],
  },
  {
    heading: "Your diary",
    items: [
      { href: "/admin/schedules", label: "Opening hours" },
      { href: "/admin/exceptions", label: "Leave & closures" },
      { href: "/admin/resources", label: "People & rooms" },
      { href: "/admin/services", label: "Services" },
    ],
  },
  {
    heading: "What it says",
    items: [{ href: "/admin/knowledge", label: "What you tell customers" }],
  },
  {
    heading: "Setup",
    items: [
      { href: "/admin/integration", label: "Other software" },
      { href: "/admin/settings", label: "Settings" },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const theme = await readTheme();

  return (
    <div className="flex min-h-screen flex-col bg-paper md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-rule bg-surface md:sticky md:top-0 md:h-screen md:w-[184px] md:border-b-0 md:border-r">
        {/* The product's mark, and only the product's mark. The business used to
            sit here, which docs/logo-reference.md §8 names as the single most
            expensive mistake available with a white-label product: a customer's
            name under the mark reads as a lockup, and the next prospect to see
            it is looking at a competitor's branding inside software they are
            being asked to buy. Whose data this is now lives in the account area
            at the foot, under a neutral label, where it answers the question it
            is actually for. */}
        <Link href="/admin" className="flex items-center px-3 py-3.5">
          <Lockup size={22} />
        </Link>

        <SideNav sections={NAV} />

        <div className="mt-auto flex flex-col gap-2 border-t border-rule px-3 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="eyebrow">Business</span>
            <span className="truncate text-[13px] font-medium text-ink" title={user.tenantName}>
              {user.tenantName}
            </span>
            <span className="truncate text-[11px] text-ink-faint" title={user.email}>
              {user.email}
            </span>
          </div>
          <form action={signOut}>
            <button type="submit" className="btn btn-ghost">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Top right of the screen, the same place it sits on the sign-in pages and
          on the landing page. It is a setting people reach for once and then
          look for in the same corner every time — which is an argument for one
          position across every surface, not for the tidiest spot on each. */}
      <ThemeCorner initial={theme} />

      {/* 24px of page padding and a ~1150px measure: past that, a table's first
          and last columns are far enough apart to lose the row between them. */}
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1150px] px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
