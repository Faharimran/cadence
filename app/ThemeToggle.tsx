"use client";

import { useState, useTransition } from "react";
import type { Theme } from "@/lib/theme";
import { setTheme } from "./theme-actions";

/**
 * Light / System / Dark.
 *
 * Three segments rather than a two-way switch, because "follow my computer" is
 * a genuine third answer and a binary toggle silently takes it away from
 * everyone who was relying on it.
 *
 * The DOM is updated first and the cookie written after. Waiting for the round
 * trip would leave the button looking pressed and the page unchanged for a
 * couple of hundred milliseconds, which reads as broken; the cookie only has to
 * win on the *next* page load, and it does.
 */
export function ThemeToggle({ initial, onShell }: { initial: Theme; onShell?: boolean }) {
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

  const options: { value: Theme; label: string; glyph: string }[] = [
    { value: "light", label: "Light", glyph: "☀" },
    { value: "system", label: "Follow my computer", glyph: "◐" },
    { value: "dark", label: "Dark", glyph: "☾" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={`flex items-center gap-0.5 rounded-full p-0.5 ${
        onShell ? "bg-white/10" : "border border-rule bg-surface-2"
      }`}
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
            className={`grid size-6 place-items-center rounded-full text-[11px] leading-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${
              onShell
                ? active
                  ? "bg-white text-shell focus-visible:outline-white"
                  : "text-on-shell-2 hover:text-on-shell focus-visible:outline-white"
                : active
                  ? "bg-surface text-ink shadow-sm focus-visible:outline-accent"
                  : "text-ink-3 hover:text-ink focus-visible:outline-accent"
            }`}
          >
            <span aria-hidden>{o.glyph}</span>
            <span className="sr-only">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
