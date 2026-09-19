import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Playfair_Display } from "next/font/google";
import { readTheme, themeAttribute } from "@/lib/theme";
import "./globals.css";

/**
 * Two families. Not three.
 *
 * Plus Jakarta Sans carries the entire interface — every label, every table
 * cell, every number. It is a geometric sans with enough width at 13px to stay
 * legible in a dense table, which is the size most of this product is read at.
 *
 * Playfair is for the logotype and display headlines only, and is loaded at
 * three weights for that reason. Every extra face is another render-blocking
 * request for something no reader can name.
 */
const interfaceFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-interface",
  weight: ["400", "500", "600", "700"],
});

const display = Playfair_Display({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "enori — an assistant that only says what you approved",
  description:
    "enori answers your customers on WhatsApp, books into your real calendar, and hands over anything you have not approved it to say.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Stamped server-side so the first paint is already the right theme. Read
  // from a cookie on the client instead and the page renders in the default
  // and corrects a frame later — the flash every hand-rolled toggle has.
  const theme = await readTheme();

  return (
    <html
      lang="en"
      className={`h-full ${interfaceFont.variable} ${display.variable}`}
      {...themeAttribute(theme)}
    >
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
