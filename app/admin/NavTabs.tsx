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
    // One row. Ten destinations at the previous sizing came to roughly 1130px
    // against 1104px of usable width — about 25px over, which is why Settings
    // was landing on a second line. Tightening the pills rather than widening
    // the bar keeps the nav aligned with the content sheet below it.
    //
    // `overflow-x-auto` is the fallback for genuinely narrow viewports, where
    // one row cannot fit at any sensible size and a scrolling tab strip is the
    // familiar behaviour. It does not engage at desktop widths.
    <nav className="mx-auto max-w-6xl overflow-x-auto px-6 pb-3">
      <ul className="flex flex-nowrap gap-1">
        {items.map((item) => {
          const current =
            item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`inline-block whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
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
