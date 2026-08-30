import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { signOut } from "@/app/signin/actions";
import { NavTabs } from "./NavTabs";

/**
 * Admin shell.
 *
 * `requireUser()` here is not decoration — a layout runs for every page beneath
 * it, so this is the second line of defence after proxy.ts. Each page and action
 * still calls it independently, because a layout guard alone would not protect a
 * Server Action invoked by direct POST.
 *
 * The shape is a coloured band with the working area lifted into it. The band
 * carries identity and navigation; the sheet carries the work. Beyond looking
 * less like a spreadsheet, it does a real job: the colour is how you know at a
 * glance that this is a business admin and not the operator console, which is
 * near-black.
 */

const NAV = [
  { href: "/admin", label: "Today" },
  { href: "/admin/exceptions", label: "Leave & closures" },
  { href: "/admin/schedules", label: "Opening hours" },
  { href: "/admin/resources", label: "People & rooms" },
  { href: "/admin/services", label: "Services" },
  { href: "/admin/knowledge", label: "What you tell customers" },
  { href: "/admin/bookings", label: "Bookings" },
  { href: "/admin/conversations", label: "Conversations" },
  { href: "/admin/integration", label: "Other software" },
  { href: "/admin/settings", label: "Settings" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="bg-shell text-on-shell">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="grid size-7 place-items-center rounded-lg text-[12px] font-bold"
              style={{ background: "var(--lime)", color: "var(--lime-ink)" }}
            >
              c
            </span>
            <span className="font-display text-[15px] font-semibold tracking-tight">
              {user.tenantName}
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-4">
            <span className="hidden font-mono text-[11px] text-on-shell-2 sm:inline">
              {user.email} · {user.role}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        <NavTabs items={NAV} />
      </header>

      {/* Lifted into the band by its own height, so the sheet reads as sitting
          on top of it rather than butting against it. */}
      <main className="mx-auto -mt-3 w-full max-w-6xl flex-1 rounded-t-2xl bg-paper px-6 py-8 sm:px-8">
        {children}
      </main>
    </div>
  );
}
