import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProposalHQ",
  description: "Client-ready proposals in minutes",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
