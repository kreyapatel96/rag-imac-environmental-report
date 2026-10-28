import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "iMac Visual Document RAG",
  description: "Ask questions about the Apple iMac Product Environmental Report with page-level citations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
