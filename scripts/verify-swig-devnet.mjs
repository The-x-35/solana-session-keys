// Headless end-to-end proof of the /swig flow against real devnet.
// Mirrors the app's Design A: a session-capable root authority scoped to ONLY a
// SOL spend cap, so the session key inherits just the cap (enforced on-chain).
import web3 from "@solana/web3.js";
const {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction,
  sendAndConfirmTransaction, PublicKey,
} = web3;
import swigPkg from "@swig-wallet/classic";
const {
  Actions, createEd25519AuthorityInfo, createEd25519SessionAuthorityInfo,
  fetchSwig, findSwigPda, getAddAuthorityInstructions,
  getCreateSessionInstructions, getCreateSwigInstruction, getSignInstructions,
  getSwigWalletAddress,
} = swigPkg;

function rpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  try {
    const m = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
      .match(/^NEXT_PUBLIC_RPC_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return "https://api.devnet.solana.com";
}
const c = new Connection(rpcUrl(), "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP = BigInt(0.1 * LAMPORTS_PER_SOL);
const MAX_SLOTS = 1_000_000n;

async function send(ixs, payer, signers = []) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(c, tx, [payer, ...signers], { commitment: "confirmed" });
  return sig;
}

// Fund from a local CLI keypair (devnet faucet is rate-limited). Override with
// KEYPAIR_PATH. This spends only valueless devnet test SOL (rent + fees).
import { readFileSync } from "node:fs";
import os from "node:os";
const kpPath = process.env.KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8"))));
console.log("payer:", payer.publicKey.toBase58(), "(from", kpPath + ")");
const startBal = (await c.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
console.log("balance:", startBal, "SOL\n");
if (startBal < 0.4) { console.log("ABORT: need >=0.4 devnet SOL to run the test."); process.exit(2); }

// 1. create Swig — ROOT must have ManageAuthority/All (verified on-chain)
const id = crypto.getRandomValues(new Uint8Array(32));
const swigAddr = findSwigPda(id);
const createIx = await getCreateSwigInstruction({
  payer: payer.publicKey, id,
  authorityInfo: createEd25519AuthorityInfo(payer.publicKey),
  actions: Actions.set().all().get(),
});
console.log("1. createSwig (root=all):", await send([createIx], payer));

let swig = await fetchSwig(c, swigAddr);
const walletAddr = await getSwigWalletAddress(swig);
console.log("   swig wallet:", walletAddr.toBase58());

// 2. fund the swig wallet
console.log("2. fund swig wallet:", await send([SystemProgram.transfer({
  fromPubkey: payer.publicKey, toPubkey: walletAddr, lamports: 0.3 * LAMPORTS_PER_SOL,
})], payer));

// 3a. add a SEPARATE session-capable authority scoped to ONLY solLimit=CAP
swig = await fetchSwig(c, swigAddr);
const addIxs = await getAddAuthorityInstructions(
  swig, 0,
  createEd25519SessionAuthorityInfo(payer.publicKey, MAX_SLOTS),
  Actions.set().solLimit({ amount: CAP }).get(),
);
console.log("3a. addAuthority (scoped session role):", await send(addIxs, payer));

// 3b. open a 120s session on that scoped role, bound to an ephemeral key
swig = await fetchSwig(c, swigAddr);
const scopedRole = swig.roles.find((r) => r.id !== 0 && r.isSessionBased());
console.log("    scoped role id:", scopedRole?.id);
const ephemeral = Keypair.generate();
const durationSlots = BigInt(Math.ceil((120 * 1000) / 400));
const sessIxs = await getCreateSessionInstructions(swig, scopedRole.id, ephemeral.publicKey, durationSlots, { payer: payer.publicKey });
console.log("3b. createSession:", await send([
  ...sessIxs,
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ephemeral.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
], payer));

swig = await fetchSwig(c, swigAddr);
const role = swig.findRoleBySessionKey(ephemeral.publicKey);
console.log("   session role found:", !!role, "| sessionBased:", role?.isSessionBased());
console.log("   expirySlot:", role.authority.expirySlot.toString(), "| canSpend 0.02:", role.actions.canSpendSol(BigInt(0.02 * LAMPORTS_PER_SOL)), "| canSpend 0.15:", role.actions.canSpendSol(BigInt(0.15 * LAMPORTS_PER_SOL)));

// 4. within cap -> expect SUCCESS, signed only by the ephemeral session key
try {
  const ix = SystemProgram.transfer({ fromPubkey: walletAddr, toPubkey: payer.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL });
  const signIxs = await getSignInstructions(swig, role.id, [ix], false, { payer: ephemeral.publicKey });
  console.log("4. WITHIN cap (0.02) signed by session key:", await send(signIxs, ephemeral), "✅ SUCCESS");
} catch (e) { console.log("4. WITHIN cap UNEXPECTEDLY FAILED:", e.message, "❌"); }

// 5. over cap -> expect on-chain REJECTION
try {
  const ix = SystemProgram.transfer({ fromPubkey: walletAddr, toPubkey: payer.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL });
  const signIxs = await getSignInstructions(swig, role.id, [ix], false, { payer: ephemeral.publicKey });
  console.log("5. OVER cap (0.15):", await send(signIxs, ephemeral), "❌ SHOULD HAVE BEEN REJECTED");
} catch (e) { console.log("5. OVER cap (0.15) rejected on-chain ✅ -", (e.message || "").split("\n")[0].slice(0, 120)); }

// 6. revoke (zero-key)
try {
  swig = await fetchSwig(c, swigAddr);
  const zero = new PublicKey(new Uint8Array(32));
  const ix = await getCreateSessionInstructions(swig, role.id, zero, 1n, { payer: payer.publicKey });
  console.log("6. revoke:", await send(ix, payer), "✅");
} catch (e) { console.log("6. revoke failed:", e.message, "❌"); }

// 7. after revoke, the old session key should no longer be able to spend
try {
  swig = await fetchSwig(c, swigAddr);
  const r2 = swig.findRoleBySessionKey(ephemeral.publicKey);
  console.log("7. old session key still a valid role after revoke?", !!r2, r2 ? "(unexpected)" : "✅ revoked");
} catch (e) { console.log("7. check:", e.message); }

console.log("\nDONE — see explorer (cluster=devnet) for each signature above.");
