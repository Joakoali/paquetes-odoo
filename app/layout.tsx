import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Paquetería",
  description: "Captura y validación de recepciones y entregas de paquetería",
};

// The color of the browser bar on a phone, and of the status bar once the app is on the home screen.
export const viewport: Viewport = {
  themeColor: "#1d1d1f",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
