import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  Actions,
  createEd25519AuthorityInfo,
  createEd25519SessionAuthorityInfo,
  fetchNullableSwig,
  fetchSwig,
  findSwigPda,
  getAddAuthorityInstructions,
  getCreateSessionInstructions,
  getCreateSwigInstruction,
  getSignInstructions,
  getSwigWalletAddress,
} from "@swig-wallet/classic";

const SLOT_MS = 400;
// Ceiling on session length set at authority creation (~37 days of slots) so a
// 1-week auto-top-up session fits well within it.
const MAX_SESSION_SLOTS = 8_000_000n;
const FEE_FUNDING_LAMPORTS = Math.round(0.01 * LAMPORTS_PER_SOL);

export const RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() ||
  process.env.NEXT_PUBLIC_RPC_URL?.trim() ||
  "https://api.mainnet-beta.solana.com";

export function connection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

const secondsToSlots = (seconds: number) =>
  BigInt(Math.max(1, Math.ceil((seconds * 1000) / SLOT_MS)));

// A Swig id is any 32 bytes; a Solana pubkey is exactly 32 bytes, so deriving
// the id from the owner makes the wallet deterministic and rediscoverable from
// chain state alone.
const swigIdFor = (owner: PublicKey) => owner.toBytes();

function addresses(owner: PublicKey) {
  const id = swigIdFor(owner);
  return { id, swigAddress: findSwigPda(id) };
}

async function freshTx(
  conn: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
): Promise<Transaction> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer;
  const { blockhash } = await conn.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  return tx;
}

function serialize(tx: Transaction): string {
  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

async function decimalsOf(conn: Connection, mint: PublicKey): Promise<number> {
  return (await getMint(conn, mint)).decimals;
}

const toBaseUnits = (human: number, decimals: number) =>
  BigInt(Math.round(human * 10 ** decimals));

const fromBaseUnits = (base: bigint, decimals: number) =>
  Number(base) / 10 ** decimals;

// ── status ────────────────────────────────────────────────────────────────

export async function getStatus(
  ownerStr: string,
  sessionKeyStr?: string,
  mintStr?: string,
) {
  const owner = new PublicKey(ownerStr);
  const conn = connection();
  const { swigAddress } = addresses(owner);
  const currentSlot = await conn.getSlot("confirmed");
  const swig = await fetchNullableSwig(conn, swigAddress);
  if (!swig) {
    return { exists: false, swigAddress: swigAddress.toBase58(), currentSlot };
  }
  const walletAddress = await getSwigWalletAddress(swig);
  const lamports = await conn.getBalance(walletAddress, "confirmed");

  const result: Record<string, unknown> = {
    exists: true,
    swigAddress: swigAddress.toBase58(),
    walletAddress: walletAddress.toBase58(),
    walletBalanceSol: lamports / LAMPORTS_PER_SOL,
    currentSlot,
  };

  const mint = mintStr ? new PublicKey(mintStr) : null;
  let decimals: number | null = null;
  if (mint) {
    decimals = await decimalsOf(conn, mint);
    const ata = getAssociatedTokenAddressSync(mint, walletAddress, true);
    let bal = 0n;
    try {
      bal = (await getAccount(conn, ata)).amount;
    } catch {
      bal = 0n;
    }
    result.mint = mintStr;
    result.walletTokenBalanceBaseUnits = bal.toString();
    result.walletTokenBalance = fromBaseUnits(bal, decimals);
  }

  if (sessionKeyStr) {
    const role = swig.findRoleBySessionKey(new PublicKey(sessionKeyStr));
    if (role && role.isSessionBased()) {
      const expirySlot = role.authority.expirySlot;
      const session: Record<string, unknown> = {
        sessionKey: sessionKeyStr,
        roleId: role.id,
        active: BigInt(currentSlot) <= expirySlot,
        expired: BigInt(currentSlot) > expirySlot,
        expirySlot: expirySlot.toString(),
        secondsRemaining: Math.max(
          0,
          Math.round((Number(expirySlot) - currentSlot) * (SLOT_MS / 1000)),
        ),
      };
      if (mint) {
        const cap = role.actions.tokenSpendLimit(mint);
        session.tokenCapRemainingBaseUnits = cap != null ? cap.toString() : null;
        session.tokenCapRemaining =
          cap != null && decimals != null ? fromBaseUnits(cap, decimals) : null;
      } else {
        const cap = role.actions.solSpendLimit?.();
        session.capRemainingLamports = cap != null ? cap.toString() : null;
        session.capRemainingSol = cap != null ? Number(cap) / LAMPORTS_PER_SOL : null;
      }
      result.session = session;
    } else {
      result.session = null;
    }
  }
  return result;
}

// ── create ──────────────────────────────────────────────────────────────────

export async function prepareCreate(ownerStr: string) {
  const owner = new PublicKey(ownerStr);
  const conn = connection();
  const { id, swigAddress } = addresses(owner);

  const existing = await fetchNullableSwig(conn, swigAddress);
  if (existing) {
    const walletAddress = await getSwigWalletAddress(existing);
    return {
      alreadyExists: true,
      swigAddress: swigAddress.toBase58(),
      walletAddress: walletAddress.toBase58(),
    };
  }

  const ix = await getCreateSwigInstruction({
    payer: owner,
    id,
    authorityInfo: createEd25519AuthorityInfo(owner),
    actions: Actions.set().all().get(),
  });
  const tx = await freshTx(conn, owner, [ix]);
  return {
    alreadyExists: false,
    swigAddress: swigAddress.toBase58(),
    txBase64: serialize(tx),
  };
}

// ── fund ──────────────────────────────────────────────────────────────────
// SOL when no mint; otherwise an SPL transfer from the owner's ATA into the
// Swig wallet's ATA (created idempotently, owner pays the rent).

export async function prepareFund(
  ownerStr: string,
  amount: number,
  mintStr?: string,
) {
  const owner = new PublicKey(ownerStr);
  const conn = connection();
  const { swigAddress } = addresses(owner);
  const swig = await fetchSwig(conn, swigAddress);
  const walletAddress = await getSwigWalletAddress(swig);

  if (!mintStr) {
    const ix = SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: walletAddress,
      lamports: Math.round(amount * LAMPORTS_PER_SOL),
    });
    const tx = await freshTx(conn, owner, [ix]);
    return { txBase64: serialize(tx), walletAddress: walletAddress.toBase58() };
  }

  const mint = new PublicKey(mintStr);
  const decimals = await decimalsOf(conn, mint);
  const base = toBaseUnits(amount, decimals);
  const ownerAta = getAssociatedTokenAddressSync(mint, owner, true);
  const walletAta = getAssociatedTokenAddressSync(mint, walletAddress, true);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      walletAta,
      walletAddress,
      mint,
    ),
    createTransferCheckedInstruction(
      ownerAta,
      mint,
      walletAta,
      owner,
      base,
      decimals,
    ),
  ];
  const tx = await freshTx(conn, owner, ixs);
  return {
    txBase64: serialize(tx),
    walletAddress: walletAddress.toBase58(),
    walletTokenAccount: walletAta.toBase58(),
  };
}

// ── authorize step 1: add a scoped, spend-capped session authority ──────────

export async function prepareAddAuthority(
  ownerStr: string,
  cap: number,
  mintStr?: string,
  destinationStr?: string,
) {
  const owner = new PublicKey(ownerStr);
  const conn = connection();
  const { swigAddress } = addresses(owner);
  const swig = await fetchSwig(conn, swigAddress);

  let actions;
  if (!mintStr) {
    actions = Actions.set()
      .solLimit({ amount: BigInt(Math.round(cap * LAMPORTS_PER_SOL)) })
      .get();
  } else {
    const mint = new PublicKey(mintStr);
    const decimals = await decimalsOf(conn, mint);
    const amount = toBaseUnits(cap, decimals);
    if (destinationStr) {
      // Locked: the session may only send this token to the recipient's ATA,
      // capped at `amount` total. The destination-limit check compares the SPL
      // transfer's destination *token account*, so lock to the ATA (derived
      // from the recipient owner) — matched by a plain transfer in prepareSpend.
      const destAta = getAssociatedTokenAddressSync(
        mint,
        new PublicKey(destinationStr),
        true,
      );
      actions = Actions.set()
        .tokenDestinationLimit({ mint, amount, destination: destAta })
        .get();
    } else {
      actions = Actions.set().tokenLimit({ mint, amount }).get();
    }
  }

  const ixs = await getAddAuthorityInstructions(
    swig,
    0,
    createEd25519SessionAuthorityInfo(owner, MAX_SESSION_SLOTS),
    actions,
  );
  const tx = await freshTx(conn, owner, ixs);
  return { txBase64: serialize(tx) };
}

// ── authorize step 2: open the session on the newest scoped role ────────────

export async function prepareOpenSession(
  ownerStr: string,
  sessionKeyStr: string,
  durationSeconds: number,
) {
  const owner = new PublicKey(ownerStr);
  const sessionKey = new PublicKey(sessionKeyStr);
  const conn = connection();
  const { swigAddress } = addresses(owner);
  const swig = await fetchSwig(conn, swigAddress);

  const scopedRole = [...swig.roles]
    .filter((r) => r.id !== 0 && r.isSessionBased())
    .sort((a, b) => b.id - a.id)[0];
  if (!scopedRole) {
    throw new Error(
      "no scoped session role found — call prepare-add-authority first",
    );
  }

  const sessIxs = await getCreateSessionInstructions(
    swig,
    scopedRole.id,
    sessionKey,
    secondsToSlots(durationSeconds),
    { payer: owner },
  );
  const topUp = SystemProgram.transfer({
    fromPubkey: owner,
    toPubkey: sessionKey,
    lamports: FEE_FUNDING_LAMPORTS,
  });
  const tx = await freshTx(conn, owner, [...sessIxs, topUp]);
  return {
    txBase64: serialize(tx),
    roleId: scopedRole.id,
    feeFundingLamports: FEE_FUNDING_LAMPORTS,
  };
}

// ── spend (signed by the session key, no owner approval) ─────────────────────
// The session key is fee payer + only signer; the Swig program co-signs the
// wrapped transfer and rejects it on-chain over the cap or after expiry. For
// SPL, the recipient ATA is created idempotently (session key pays the rent).

export async function prepareSpend(
  ownerStr: string,
  sessionKeyStr: string,
  toStr: string,
  amount: number,
  mintStr?: string,
) {
  const owner = new PublicKey(ownerStr);
  const sessionKey = new PublicKey(sessionKeyStr);
  const to = new PublicKey(toStr);
  const conn = connection();
  const { swigAddress } = addresses(owner);
  const swig = await fetchSwig(conn, swigAddress);

  const role = swig.findRoleBySessionKey(sessionKey);
  if (!role) throw new Error("session role not found (revoked or expired?)");
  const walletAddress = await getSwigWalletAddress(swig);

  let extra: TransactionInstruction[] = [];
  let transferIx: TransactionInstruction;

  if (!mintStr) {
    transferIx = SystemProgram.transfer({
      fromPubkey: walletAddress,
      toPubkey: to,
      lamports: Math.round(amount * LAMPORTS_PER_SOL),
    });
  } else {
    const mint = new PublicKey(mintStr);
    const decimals = await decimalsOf(conn, mint);
    const sourceAta = getAssociatedTokenAddressSync(mint, walletAddress, true);
    const destAta = getAssociatedTokenAddressSync(mint, to, true);
    extra = [
      createAssociatedTokenAccountIdempotentInstruction(
        sessionKey,
        destAta,
        to,
        mint,
      ),
    ];
    // Plain SPL transfer (accounts: source, dest, authority) — destination is
    // at index 1, which is what the Swig destination-limit check reads. A
    // transferChecked inserts the mint at index 1 and breaks that check.
    transferIx = createTransferInstruction(
      sourceAta,
      destAta,
      walletAddress,
      toBaseUnits(amount, decimals),
    );
  }

  const signIxs = await getSignInstructions(swig, role.id, [transferIx], false, {
    payer: sessionKey,
  });
  const tx = await freshTx(conn, sessionKey, [...extra, ...signIxs]);
  return { txBase64: serialize(tx), feePayer: sessionKey.toBase58() };
}

// ── revoke (zero-key re-session on the session's role; owner-signed) ─────────

export async function prepareRevoke(ownerStr: string, sessionKeyStr: string) {
  const owner = new PublicKey(ownerStr);
  const conn = connection();
  const { swigAddress } = addresses(owner);
  const swig = await fetchSwig(conn, swigAddress);
  const role = swig.findRoleBySessionKey(new PublicKey(sessionKeyStr));
  if (!role) throw new Error("active session role not found");
  const zeroKey = new PublicKey(new Uint8Array(32));
  const ixs = await getCreateSessionInstructions(swig, role.id, zeroKey, 1n, {
    payer: owner,
  });
  const tx = await freshTx(conn, owner, ixs);
  return { txBase64: serialize(tx) };
}

// ── reclaim (root-signed sweep back to the owner) ───────────────────────────
// SOL sweep leaves the rent reserve; SPL sweep moves the full token balance.

export async function prepareReclaim(ownerStr: string, mintStr?: string) {
  const owner = new PublicKey(ownerStr);
  const conn = connection();
  const { swigAddress } = addresses(owner);
  const swig = await fetchSwig(conn, swigAddress);
  const walletAddress = await getSwigWalletAddress(swig);

  if (!mintStr) {
    const bal = await conn.getBalance(walletAddress, "confirmed");
    const rentReserve = await conn.getMinimumBalanceForRentExemption(0);
    const sweep = bal - rentReserve;
    if (sweep <= 0) {
      return { nothingToReclaim: true, walletAddress: walletAddress.toBase58() };
    }
    const transferIx = SystemProgram.transfer({
      fromPubkey: walletAddress,
      toPubkey: owner,
      lamports: sweep,
    });
    const signIxs = await getSignInstructions(swig, 0, [transferIx], false, {
      payer: owner,
    });
    const tx = await freshTx(conn, owner, signIxs);
    return {
      txBase64: serialize(tx),
      sweepSol: sweep / LAMPORTS_PER_SOL,
      walletAddress: walletAddress.toBase58(),
    };
  }

  const mint = new PublicKey(mintStr);
  const decimals = await decimalsOf(conn, mint);
  const sourceAta = getAssociatedTokenAddressSync(mint, walletAddress, true);
  let amount = 0n;
  try {
    amount = (await getAccount(conn, sourceAta)).amount;
  } catch {
    amount = 0n;
  }
  if (amount <= 0n) {
    return { nothingToReclaim: true, walletAddress: walletAddress.toBase58() };
  }
  const ownerAta = getAssociatedTokenAddressSync(mint, owner, true);
  const extra = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ownerAta,
      owner,
      mint,
    ),
  ];
  const transferIx = createTransferCheckedInstruction(
    sourceAta,
    mint,
    ownerAta,
    walletAddress,
    amount,
    decimals,
  );
  const signIxs = await getSignInstructions(swig, 0, [transferIx], false, {
    payer: owner,
  });
  const tx = await freshTx(conn, owner, [...extra, ...signIxs]);
  return {
    txBase64: serialize(tx),
    sweepAmount: fromBaseUnits(amount, decimals),
    sweepAmountBaseUnits: amount.toString(),
    walletAddress: walletAddress.toBase58(),
  };
}

// ── submit (broadcast an app-signed transaction and confirm) ─────────────────

export async function submit(signedTxBase64: string) {
  const conn = connection();
  const raw = Buffer.from(signedTxBase64, "base64");
  const sig = await conn.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  for (let i = 0; i < 30; i++) {
    const st = await conn.getSignatureStatus(sig);
    const v = st?.value;
    if (v?.err) throw new Error(`transaction failed: ${JSON.stringify(v.err)}`);
    if (
      v?.confirmationStatus === "confirmed" ||
      v?.confirmationStatus === "finalized"
    ) {
      return { signature: sig, confirmed: true };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { signature: sig, confirmed: false };
}
