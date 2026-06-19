// End-to-end proof of the SPL-token path of /api/swig/* against real devnet.
// Mints a throwaway 6-decimal token (stands in for USDC), funds the Swig wallet
// with it, opens a token-capped session, then proves a within-cap spend
// succeeds and an over-cap spend is rejected on-chain — all signed on the
// "device" (owner key for setup, ephemeral session key for spends).
//
// The helper server MUST be pointed at devnet for this. Run:
//   SOLANA_RPC_URL="$DEVNET" npm run dev      # terminal 1
//   BASE_URL=http://localhost:<port> npm run verify:api:spl   # terminal 2
import web3 from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import os from "node:os";

const { Keypair, Transaction, Connection } = web3;

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

function fromEnvLocal(key) {
  try {
    const m = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(
      new RegExp(`^${key}=(.+)$`, "m"),
    );
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

const BEARER = process.env.BEARER || fromEnvLocal("SESSION_HELPER_BEARER");
const DEVNET =
  process.env.DEVNET_RPC ||
  fromEnvLocal("NEXT_PUBLIC_RPC_URL") ||
  "https://api.devnet.solana.com";
if (!BEARER) {
  console.error("No BEARER — set SESSION_HELPER_BEARER in .env.local");
  process.exit(2);
}

const kpPath = process.env.KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
const owner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8"))),
);
const session = Keypair.generate();
const conn = new Connection(DEVNET, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, json: await res.json() };
}
async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { authorization: `Bearer ${BEARER}` },
  });
  return { status: res.status, json: await res.json() };
}
async function signAndSubmit(txBase64, signer) {
  const tx = Transaction.from(Buffer.from(txBase64, "base64"));
  tx.partialSign(signer);
  const signedTxBase64 = tx.serialize({ requireAllSignatures: false }).toString("base64");
  return post("/api/swig/submit", { signedTxBase64 });
}

const ownerStr = owner.publicKey.toBase58();
const sessionStr = session.publicKey.toBase58();

console.log("base:   ", BASE_URL);
console.log("devnet: ", DEVNET.replace(/api-key=.*/, "api-key=***"));
console.log("owner:  ", ownerStr);
console.log("session:", sessionStr, "(ephemeral)\n");

// 0. mint a throwaway 6-decimal token and give the owner 100 of it
console.log("0. creating test mint (6 decimals)…");
const mint = await createMint(conn, owner, owner.publicKey, null, 6);
const mintStr = mint.toBase58();
const ownerAta = await getOrCreateAssociatedTokenAccount(conn, owner, mint, owner.publicKey);
await mintTo(conn, owner, mint, ownerAta.address, owner, 100_000_000n);
console.log("   mint:", mintStr, "| owner balance: 100\n");

// 1. ensure the Swig wallet exists (idempotent — owner reuses their devnet Swig)
let r = await post("/api/swig/prepare-create", { owner: ownerStr });
console.log("1. prepare-create:", r.json.alreadyExists ? "(exists)" : "(new)");
if (!r.json.alreadyExists) {
  console.log("   create:", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
  await sleep(2000);
}

// 2. fund the Swig wallet with 30 tokens
r = await post("/api/swig/prepare-fund", { owner: ownerStr, mint: mintStr, amount: 30 });
console.log("2. prepare-fund (30 tokens):", r.status, "→", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
await sleep(2500);

// 3. add a token-capped session authority (cap = 10 tokens)
r = await post("/api/swig/prepare-add-authority", { owner: ownerStr, mint: mintStr, capAmount: 10 });
console.log("3. prepare-add-authority (cap 10):", r.status, "→", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
await sleep(2500);

// 4. open a 180s session bound to the ephemeral key
r = await post("/api/swig/prepare-open-session", { owner: ownerStr, sessionKey: sessionStr, durationSeconds: 180 });
console.log("4. prepare-open-session:", r.status, "roleId:", r.json.roleId, "→", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
await sleep(2500);

// 5. status with the mint — token cap + wallet token balance
r = await get(`/api/swig/status?owner=${ownerStr}&sessionKey=${sessionStr}&mint=${mintStr}`);
console.log("5. status:", JSON.stringify({ walletTokenBalance: r.json.walletTokenBalance, session: r.json.session }));

// 6. spend WITHIN cap (2 tokens) — signed only by the session key
r = await post("/api/swig/prepare-spend", { owner: ownerStr, sessionKey: sessionStr, to: ownerStr, mint: mintStr, amount: 2 });
const within = await signAndSubmit(r.json.txBase64, session);
console.log("6. WITHIN cap (2):", within.status === 200 ? "✅" : "❌", JSON.stringify(within.json));
await sleep(2500);

// 7. spend OVER cap (15 tokens) — expect on-chain rejection
r = await post("/api/swig/prepare-spend", { owner: ownerStr, sessionKey: sessionStr, to: ownerStr, mint: mintStr, amount: 15 });
const over = await signAndSubmit(r.json.txBase64, session);
console.log("7. OVER cap (15):", over.status !== 200 ? "✅ rejected" : "❌ unexpectedly succeeded");
console.log("   detail:", JSON.stringify(over.json).slice(0, 220));
await sleep(2000);

// 8. revoke
r = await post("/api/swig/prepare-revoke", { owner: ownerStr, sessionKey: sessionStr });
console.log("8. prepare-revoke:", r.status, "→", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
await sleep(2500);

// 9. reclaim the token balance back to the owner
r = await post("/api/swig/prepare-reclaim", { owner: ownerStr, mint: mintStr });
console.log("9. prepare-reclaim:", r.status, r.json.nothingToReclaim ? "(nothing)" : `sweep ${r.json.sweepAmount} tokens`);
if (!r.json.nothingToReclaim) {
  console.log("   reclaim:", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
}

console.log("\nDONE.");
