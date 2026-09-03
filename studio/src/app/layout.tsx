import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { IBM_Plex_Mono, Manrope, Newsreader } from "next/font/google";
import "./globals.css";

const body = Manrope({ variable: "--font-body", subsets: ["latin"] });
const display = Newsreader({ variable: "--font-display", subsets: ["latin"] });
const mono = IBM_Plex_Mono({ variable: "--font-mono", weight: ["400", "500"], subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Studio Charly", template: "%s · Studio Charly" },
  description: "Base de connaissances et parcours d’onboarding de Charly.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const isDevelopmentAuthBypass =
    process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true";

  return <html lang="fr" className={`${body.variable} ${display.variable} ${mono.variable}`}><body>
    {isDevelopmentAuthBypass
      ? children
      : <ClerkProvider afterSignOutUrl="/connexion">{children}</ClerkProvider>}
  </body></html>;
}
