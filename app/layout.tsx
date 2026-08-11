import type { Metadata, Viewport } from "next";
import "./globals.css";
import JarvisButton from "./components/JarvisButton";
import SwRegister from "./components/SwRegister";

export const metadata: Metadata = {
  title: "Wing Digital OS",
  description: "Wing Digital Operating System",
};

// viewport-fit=cover lets env(safe-area-inset-*) resolve to real notch/home-indicator
// insets when installed as a PWA. maximumScale is left open so pinch-zoom still works
// on the ops map / vault graph.
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* PWA */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0a0a0a" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Wing OS" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="h-full">
        {children}
        <JarvisButton />
        <SwRegister />
      </body>
    </html>
  );
}
