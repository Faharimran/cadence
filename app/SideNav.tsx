"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The sidebar, sectioned.
 *
 * A long undifferentiated list of links is not navigation: nobody reads to the
 * bottom of it, and two unrelated items next to each other tell you nothing
 * about either. So the destinations are grouped by *what someone is doing when
 * they reach for them* — running today, keeping the diary right, deciding what
 * the assistant may say, connecting things up — rather than by how the features
 * were built.
 *
 * The active item is the only coloured thing in the column. That is the whole
 * job colour has here, and it is why the column itself is not painted: a solid
 * accent sidebar makes every item equally loud, so nothing indicates where you
 * are, on a surface people navigate past rather than read.
 *
 * A client component only because it needs `usePathname`. With ten destinations
 * and no visible current state, people re-read the whole list every time.
 */

export type NavItem = {
  href: string;
  label: string;
  /** Match this path exactly rather than its subtree. */
  exact?: boolean;
  /** A count worth seeing without opening the screen. */
  count?: number;
};

export type NavSection = { heading?: string; items: NavItem[] };

export function SideNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();

  return (
    // Below md the column becomes a scrolling strip — one row of links is the
    // familiar shape on a phone, and section headings are noise at that width.
    <nav className="flex gap-4 overflow-x-auto px-3 py-2 md:flex-col md:gap-4 md:overflow-visible md:px-2 md:py-1">
      {sections.map((section, i) => (
        <div key={section.heading ?? i} className="flex shrink-0 flex-col gap-1 md:shrink">
          {section.heading && (
            <p className="nav-heading mb-0.5 hidden md:block">{section.heading}</p>
          )}
          <ul className="flex gap-0.5 md:flex-col">
            {section.items.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`nav-link whitespace-nowrap ${active ? "is-active" : ""}`}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.count !== undefined && item.count > 0 && (
                      <span className="num ml-auto text-[11px] text-ink-faint">{item.count}</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
