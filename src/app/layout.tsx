import type { Metadata } from "next";
import "./globals.css";
import { KeyProvider } from "@/app/providers/KeyProvider";

export const metadata: Metadata = {
  title: "Legacy",
  description: "Your life, organized — privately.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <KeyProvider>{children}</KeyProvider>
      </body>
    </html>
  );
}
