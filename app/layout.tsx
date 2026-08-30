import type { Metadata } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import { readTheme, themeAttribute } from "@/lib/theme";
import "./globals.css";

/**
 * One display face, variable, used only for headlines.
 *
 * Bricolage rather than one of the obvious grotesques: it carries enough width
 * and contrast to hold a large headline without reading like every other
 * software landing page, and it stays legible set tight. Body text stays on the
 * system stack — a second webfont costs more than it returns on a page this
 * short, and the system stack is what the admin already uses, so the two
 * surfaces stay related.
 */
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "cadence — an assistant that only says what you approved",
  description:
    "cadence answers your customers on WhatsApp, books into your real calendar, and hands over anything you have not approved it to say.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Stamped server-side so the first paint is already the right theme. Read
  // from a cookie on the client instead and the page renders in the default
  // and corrects a frame later — the flash every hand-rolled toggle has.
  const theme = await readTheme();

  return (
    <html lang="en" className={`h-full ${display.variable}`} {...themeAttribute(theme)}>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
