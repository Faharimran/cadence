"use server";

import { cookies } from "next/headers";
import { THEME_COOKIE, isTheme } from "@/lib/theme";

/**
 * Records a theme choice.
 *
 * Not authenticated on purpose — a cookie saying "this person prefers dark" is
 * not a permission, and requiring a session would mean the sign-in pages could
 * not honour the choice. It writes nothing but its own cookie, and validates
 * the value against the closed set rather than trusting the form.
 *
 * A year, because a display preference that quietly resets is worse than one
 * that was never offered.
 */
export async function setTheme(value: string): Promise<void> {
  if (!isTheme(value)) return;

  const jar = await cookies();
  jar.set(THEME_COOKIE, value, {
    httpOnly: false, // the toggle reads it back to show the current selection
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 3600,
  });
}
