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

/** Pull the human-readable program log out of a SendTransactionError. */
export function describeTxError(err: unknown): string {
  if (err && typeof err === "object") {
    const anyErr = err as { message?: string; logs?: string[] };
    const logs = anyErr.logs?.join(" ") ?? "";
    const msg = anyErr.message ?? String(err);
    // Surface the most useful bit: program error or the message.
    if (/insufficient|exceed|limit|denied|unauthorized|expired/i.test(logs)) {
      const hit = anyErr.logs?.find((l) =>
        /insufficient|exceed|limit|denied|unauthorized|expired/i.test(l),
      );
      return hit ?? msg;
    }
    return msg;
  }
  return String(err);
}
