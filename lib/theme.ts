import { cookies } from "next/headers";

/**
 * Which theme this person chose, if they chose one.
 *
 * A cookie rather than localStorage, so the server can stamp `data-theme` on
 * `<html>` in the response it sends. With localStorage the first paint is
 * whatever the CSS defaults to and the correction lands a frame later — the
 * flash of the wrong theme that every hand-rolled toggle has.
 *
 * "system" is a real, stored answer, distinct from having never chosen. Both
 * stamp nothing, but keeping them separate means the toggle can show which of
 * the three is actually selected.
 */

export const THEME_COOKIE = "cadence_theme";

export type Theme = "system" | "light" | "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

export async function readTheme(): Promise<Theme> {
  const jar = await cookies();
  const value = jar.get(THEME_COOKIE)?.value;
  return isTheme(value) ? value : "system";
}

/**
 * What to put on `<html>`. "system" stamps nothing, leaving
 * `prefers-color-scheme` to decide — which is the whole point of that option.
 */
export function themeAttribute(theme: Theme): { "data-theme"?: "light" | "dark" } {
  return theme === "system" ? {} : { "data-theme": theme };
}
