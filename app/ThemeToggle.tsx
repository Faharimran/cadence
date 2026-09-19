"use client";

import { useState, useTransition } from "react";
import type { Theme } from "@/lib/theme";
import { Icon, type IconName } from "./icons";
import { setTheme } from "./theme-actions";

/**
 * Light / System / Dark.
 *
 * Three segments rather than a two-way switch, because "follow my computer" is
 * a genuine third answer and a binary toggle silently takes it away from
 * everyone who was relying on it.
 *
 * The glyphs are drawn, not typed. The obvious characters for this control —
 * ☀ and ☾ — are exactly the dingbats that switch to emoji presentation on their
 * own, so the same markup renders as a line drawing on one machine and a yellow
 * cartoon sun on the next.
 *
 * The DOM is updated first and the cookie written after. Waiting for the round
 * trip would leave the button looking pressed and the page unchanged for a
 * couple of hundred milliseconds, which reads as broken; the cookie only has to
 * win on the *next* page load, and it does.
 */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setLocal] = useState<Theme>(initial);
  const [, startTransition] = useTransition();

  function choose(next: Theme) {
    setLocal(next);

    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);

    startTransition(() => {
      void setTheme(next);
    });
  }

  const options: { value: Theme; label: string; icon: IconName }[] = [
    { value: "light", label: "Light", icon: "sun" },
    { value: "system", label: "Follow my computer", icon: "monitor" },
    { value: "dark", label: "Dark", icon: "moon" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-lg border border-rule bg-surface-sunken p-0.5"
    >
      {options.map((o) => {
        const active = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.label}
            onClick={() => choose(o.value)}
            className={`grid size-[22px] place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              active ? "bg-surface text-accent" : "text-ink-faint hover:text-ink"
            }`}
          >
            <Icon name={o.icon} size={12} />
            <span className="sr-only">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The same control, for a page with no chrome to sit in.
 *
 * Sign-in, sign-up and the operator sign-in are single centred cards. Someone
 * who set the landing page light and then clicks "Sign in" should not land on a
 * surface that has forgotten — and if their first encounter with enori IS the
 * sign-in page, the choice should be available there too.
 */
export function ThemeCorner({ initial }: { initial: Theme }) {
  return (
    <div className="fixed right-4 top-4 z-10">
      <ThemeToggle initial={initial} />
    </div>
  );
}
