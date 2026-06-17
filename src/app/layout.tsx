import type { Metadata } from "next";
import "./globals.css";
import { WalletProviders } from "@/components/WalletProviders";
import { NavTabs } from "@/components/NavTabs";

export const metadata: Metadata = {
  title: "Solana Session Keys POC — Swig vs MagicBlock",
  description:
    "Devnet proof-of-concept: scoped, time-limited session keys via Swig and MagicBlock/Gum. No custom on-chain program.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <WalletProviders>
          <div className="mx-auto max-w-3xl px-4 py-8">
            <header className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight">
                Solana Session Keys POC
              </h1>
              <p className="mt-1 text-sm text-zinc-400">
                Scoped, time-limited session signing on devnet — two approaches,
                no custom on-chain program.
              </p>
              <div className="mt-4">
                <NavTabs />
              </div>
            </header>
            <main className="space-y-6">{children}</main>
            <footer className="mt-12 text-xs text-zinc-600">
              Devnet only · no real funds · ephemeral keys live in memory and are
              never persisted. Not production-safe — a learning/demo artifact.
            </footer>
          </div>
        </WalletProviders>
      </body>
    </html>
  );
}
