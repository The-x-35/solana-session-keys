"use client";

import { Buffer } from "buffer";
import { ReactNode, useMemo } from "react";

// Anchor (used by the Gum SDK) expects a global Buffer in the browser.
if (typeof window !== "undefined") {
  (window as unknown as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
}

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { RPC_URL } from "@/lib/env";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Wraps the app in wallet-adapter providers pointed at devnet.
 * Phantom + Solflare are auto-detected; users connect their existing wallet.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
