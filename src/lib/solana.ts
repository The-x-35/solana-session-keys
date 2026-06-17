import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  PublicKey,
} from "@solana/web3.js";

/**
 * Send a transaction signed by an in-memory ephemeral keypair (the session key).
 * No wallet pop-up — this is the whole point of a session key.
 */
export async function sendWithKeypair(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: Keypair,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const tx = new Transaction().add(...instructions);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(payer, ...extraSigners);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

/**
 * Build a transaction, set fee payer + blockhash, ready to hand to a
 * wallet-adapter `sendTransaction`. Optional co-signers (e.g. an ephemeral key
 * that must also sign) are partial-signed here before the wallet signs.
 */
export async function buildWalletTx(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  coSigners: Keypair[] = [],
): Promise<Transaction> {
  const tx = new Transaction().add(...instructions);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  if (coSigners.length > 0) tx.partialSign(...coSigners);
  return tx;
}

const PROGRAM_HINT = /insufficient|exceed|limit|denied|unauthorized|expired|0x[0-9a-f]+/i;

/**
 * Wallet adapters wrap the real failure ("WalletSendTransactionError: Unexpected
 * error") and hide the cause in a nested `.error`/`.cause`. Walk the chain to
 * surface the actual program log or message instead of the opaque wrapper.
 */
export function describeTxError(err: unknown): string {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let best = "";
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { message?: string; logs?: string[]; error?: unknown; cause?: unknown };
    const hit = e.logs?.find((l) => PROGRAM_HINT.test(l));
    if (hit) return hit;
    if (typeof e.message === "string" && e.message && e.message !== "Unexpected error") {
      best = e.message;
    }
    cur = e.error ?? e.cause;
  }
  if (!best) {
    best =
      err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message)
        : String(err);
  }
  // If we only got the opaque wrapper, add a hint about the usual cause.
  if (best === "Unexpected error") {
    best =
      "Unexpected error (wallet rejected/failed to send — common causes: RPC rate-limited or unreachable, or your wallet is not on Devnet)";
  }
  return best;
}
