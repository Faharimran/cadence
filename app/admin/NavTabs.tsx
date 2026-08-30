"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The nav, as pills across the shell band.
 *
 * A client component only because it needs `usePathname` to mark the current
 * tab. That is worth the boundary: with eleven destinations and no visible
 * current state, people navigate by re-reading the whole row every time.
 *
 * `/admin` is matched exactly. Every other entry matches its subtree, so a
 * conversation detail page keeps "Conversations" lit.
 */
export function NavTabs({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();

  return (
    <nav className="mx-auto max-w-6xl px-6 pb-3">
      {/* Wraps rather than scrolls. Ten destinations overflow 6xl on a laptop,
          and a horizontally-scrolling row silently hides the last one or two —
          which on this nav means Settings, the tab people go looking for. A
          second line costs 32px and hides nothing. */}
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => {
          const current =
            item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`inline-block whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                  current
                    ? "bg-white font-semibold text-shell"
                    : "text-on-shell-2 hover:bg-white/12 hover:text-on-shell"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
