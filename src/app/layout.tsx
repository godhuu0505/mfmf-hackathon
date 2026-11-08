import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import WebVitalsReporter from "@/components/WebVitalsReporter";

export const metadata: Metadata = {
  applicationName: "mfmf",
  title: {
    default: "mfmf | ペット保育園記録",
    template: "%s | mfmf",
  },
  description: "ペット保育園からの記録と写真を残すアプリ",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "mfmf",
  },
  // favicon は app/icon.png のファイル規約で自動注入される。
  // ブラウザーと iOS は版付き URL で古い文字アイコンのキャッシュを更新する。
  icons: {
    icon: [
      { url: "/favicon.ico?v=20261108", sizes: "any" },
      { url: "/favicon-32.png?v=20261108", sizes: "32x32", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png?v=20261108", sizes: "180x180", type: "image/png" },
    ],
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-screen">
        <a href="#main" className="skip-link">
          メインコンテンツへスキップ
        </a>
        {children}
        <ServiceWorkerRegister />
        <WebVitalsReporter />
      </body>
    </html>
  );
}
