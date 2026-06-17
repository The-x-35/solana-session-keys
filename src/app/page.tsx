import Link from "next/link";

export default function HomePage() {
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-panel/70 p-5">
        <h2 className="text-lg font-semibold">What this proves</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">
          A user connects their wallet and{" "}
          <strong className="text-white">
            explicitly authorizes a scoped, time-limited session
          </strong>{" "}
          — an allowed action, a spending cap, and an expiry — with a single
          wallet approval. After that, an ephemeral{" "}
          <strong className="text-white">session key</strong> performs actions{" "}
          <strong className="text-white">without further wallet pop-ups</strong>{" "}
          until the session expires or is revoked. The session can never exceed
          what the user approved: scoping and consent are the whole point.
          Everything runs on <strong className="text-white">devnet</strong> and
          uses only already-deployed programs — there is no custom on-chain
          program in this repo.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/swig"
          className="group rounded-xl border border-white/10 bg-panel/70 p-5 transition hover:border-purple-400/40"
        >
          <h3 className="font-semibold text-white">Swig →</h3>
          <p className="mt-2 text-sm text-zinc-400">
            Smart-wallet session authorities. The deployed Swig program{" "}
            <strong className="text-zinc-200">itself enforces</strong> the SOL
            spend cap and slot-based expiry. Full flow: create wallet → authorize
            scoped session → session-key transfer with no popup → watch the chain
            reject over-cap / expired actions → revoke.
          </p>
          <p className="mt-3 text-xs text-emerald-300">
            Spend cap + expiry enforced on-chain
          </p>
        </Link>

        <Link
          href="/magicblock"
          className="group rounded-xl border border-white/10 bg-panel/70 p-5 transition hover:border-purple-400/40"
        >
          <h3 className="font-semibold text-white">MagicBlock / Gum →</h3>
          <p className="mt-2 text-sm text-zinc-400">
            Session-key primitive lifecycle. Create an ephemeral key → an on-chain{" "}
            <code className="text-zinc-200">SessionToken</code> account scoped to a
            target program with an expiry → sign with the session key → revoke
            (account closed). Honest note: a custom spend-cap rule would require
            deploying a session-aware program.
          </p>
          <p className="mt-3 text-xs text-amber-300">
            Lifecycle on-chain · custom gating needs a program
          </p>
        </Link>
      </div>

      <section className="rounded-xl border border-white/10 bg-panel/70 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Before you start
        </h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-zinc-300">
          <li>Install Phantom or Solflare and switch it to devnet.</li>
          <li>
            Fund your wallet with devnet SOL from the faucet link in the top bar.
          </li>
          <li>Connect, then open a demo tab and follow the numbered steps.</li>
        </ol>
      </section>
    </div>
  );
}
