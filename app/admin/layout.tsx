import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { signOut } from "@/app/signin/actions";

/**
 * Admin shell.
 *
 * `requireUser()` here is not decoration — a layout runs for every page beneath
 * it, so this is the second line of defence after proxy.ts. Each page and action
 * still calls it independently, because a layout guard alone would not protect a
 * Server Action invoked by direct POST.
 */

const NAV = [
  { href: "/admin", label: "Today" },
  { href: "/admin/exceptions", label: "Leave & closures" },
  { href: "/admin/schedules", label: "Opening hours" },
  { href: "/admin/resources", label: "People & rooms" },
  { href: "/admin/services", label: "Services" },
  { href: "/admin/bookings", label: "Bookings" },
  { href: "/admin/conversations", label: "Conversations" },
  { href: "/admin/integration", label: "Integration" },
  { href: "/admin/settings", label: "Settings" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/admin" className="font-mono text-sm font-semibold tracking-tight">
            cadence
          </Link>
          <span className="font-mono text-xs text-ink-3">{user.tenantName}</span>

          <div className="ml-auto flex items-center gap-4">
            <span className="font-mono text-[11px] text-ink-3">
              {user.email} · {user.role}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="font-mono text-[11px] text-ink-2 underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        <nav className="mx-auto max-w-6xl overflow-x-auto px-6">
          <ul className="flex gap-1 pb-px">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="inline-block whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-ink-2 hover:border-rule hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
