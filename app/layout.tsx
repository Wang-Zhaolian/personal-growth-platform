import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "个人成长平台",
  description: "记录学业、科研与成长路径",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
