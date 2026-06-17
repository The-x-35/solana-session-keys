"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { addressUrl, FAUCET_URL, shorten } from "@/lib/explorer";

// Render the wallet button client-only — it injects a wallet icon (<i>) after
// mount, which otherwise mismatches the server HTML and breaks hydration.
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

/**
 * Top bar: connect button, connected address, live SOL balance, faucet link.
 * Rendered on every demo page so the wallet state is always visible.
 */
export function WalletBar() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [balance, setBalance] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setBalance(null);
      return;
    }
    try {
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setBalance(lamports / LAMPORTS_PER_SOL);
    } catch {
      setBalance(null);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-panel/70 px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="rounded-md bg-purple-500/20 px-2 py-1 text-xs font-medium text-purple-200">
          devnet
        </span>
        {connected && publicKey ? (
          <a
            className="font-mono text-zinc-300 hover:text-white"
            href={addressUrl(publicKey.toBase58())}
            target="_blank"
            rel="noreferrer"
          >
            {shorten(publicKey.toBase58(), 6)}
          </a>
        ) : (
          <span className="text-zinc-500">not connected</span>
        )}
        {connected && (
          <span className="text-zinc-400">
            · {balance === null ? "…" : balance.toFixed(3)} SOL
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <a
          className="text-xs text-purple-300 underline hover:text-purple-200"
          href={FAUCET_URL}
          target="_blank"
          rel="noreferrer"
        >
          get devnet SOL
        </a>
        <WalletMultiButton />
      </div>
    </div>
  );
}
