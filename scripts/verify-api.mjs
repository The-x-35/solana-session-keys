// End-to-end proof of the /api/swig/* helper routes against a running server
// and real devnet. Plays the role of the Avici app's on-device signer: the
// server only ever builds unsigned transactions; this script signs them with
// local keypairs (owner = the device's Solana root key; session = a fresh
// ephemeral key the device generated) and submits via /api/swig/submit.
//
// Usage:
//   npm run dev            # in one terminal (loads .env.local)
//   npm run verify:api     # in another
//
// Env:
//   BASE_URL   default http://localhost:3000
//   BEARER     default read from .env.local SESSION_HELPER_BEARER
//   KEYPAIR_PATH default ~/.config/solana/id.json
import web3 from "@solana/web3.js";
import { readFileSync } from "node:fs";
import os from "node:os";

const { Keypair, Transaction } = web3;

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
if (!BEARER) {
  console.error("No BEARER — set SESSION_HELPER_BEARER in .env.local");
  process.exit(2);
}

const kpPath = process.env.KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
const owner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8"))),
);
const session = Keypair.generate();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { authorization: `Bearer ${BEARER}` },
  });
  const json = await res.json();
  return { status: res.status, json };
}

// Sign a server-built unsigned tx with the given keypair and broadcast it.
async function signAndSubmit(txBase64, signer) {
  const tx = Transaction.from(Buffer.from(txBase64, "base64"));
  tx.partialSign(signer);
  const signedTxBase64 = tx
    .serialize({ requireAllSignatures: false })
    .toString("base64");
  return post("/api/swig/submit", { signedTxBase64 });
}

const ownerStr = owner.publicKey.toBase58();
const sessionStr = session.publicKey.toBase58();

console.log("base:   ", BASE_URL);
console.log("owner:  ", ownerStr, `(from ${kpPath})`);
console.log("session:", sessionStr, "(ephemeral)\n");

// 1. status (pre)
let r = await get(`/api/swig/status?owner=${ownerStr}`);
console.log("1. status:", JSON.stringify(r.json));

// 2. create (idempotent)
r = await post("/api/swig/prepare-create", { owner: ownerStr });
console.log("2. prepare-create:", r.status, r.json.alreadyExists ? "(already exists)" : "(new)");
if (!r.json.alreadyExists) {
  const sub = await signAndSubmit(r.json.txBase64, owner);
  console.log("   create submit:", JSON.stringify(sub.json));
  await sleep(2000);
}

// 3. fund the swig wallet
r = await post("/api/swig/prepare-fund", { owner: ownerStr, amountSol: 0.3 });
console.log("3. prepare-fund:", r.status, "wallet:", r.json.walletAddress);
console.log("   fund submit:", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
await sleep(2000);

// 4. add scoped, spend-capped session authority (cap 0.1 SOL)
r = await post("/api/swig/prepare-add-authority", { owner: ownerStr, capSol: 0.1 });
console.log("4. prepare-add-authority:", r.status);
console.log("   add-authority submit:", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
await sleep(2500);

// 5. open a 120s session bound to the ephemeral key
r = await post("/api/swig/prepare-open-session", {
  owner: ownerStr,
  sessionKey: sessionStr,
  durationSeconds: 120,
});
console.log("5. prepare-open-session:", r.status, "roleId:", r.json.roleId);
console.log("   open-session submit:", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
await sleep(2500);

// 6. session status
r = await get(`/api/swig/status?owner=${ownerStr}&sessionKey=${sessionStr}`);
console.log("6. session status:", JSON.stringify(r.json.session));

// 7. spend WITHIN cap (0.02) — signed only by the session key, expect success
r = await post("/api/swig/prepare-spend", {
  owner: ownerStr,
  sessionKey: sessionStr,
  to: ownerStr,
  amountSol: 0.02,
});
const within = await signAndSubmit(r.json.txBase64, session);
console.log("7. WITHIN cap (0.02):", within.status === 200 ? "✅ " : "❌ ", JSON.stringify(within.json));
await sleep(2000);

// 8. spend OVER cap (0.15) — expect on-chain rejection
r = await post("/api/swig/prepare-spend", {
  owner: ownerStr,
  sessionKey: sessionStr,
  to: ownerStr,
  amountSol: 0.15,
});
const over = await signAndSubmit(r.json.txBase64, session);
console.log("8. OVER cap (0.15):", over.status !== 200 ? "✅ rejected" : "❌ unexpectedly succeeded");
console.log("   detail:", JSON.stringify(over.json).slice(0, 200));
await sleep(2000);

// 9. revoke (owner-signed)
r = await post("/api/swig/prepare-revoke", { owner: ownerStr, sessionKey: sessionStr });
console.log("9. prepare-revoke:", r.status);
console.log("   revoke submit:", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
await sleep(2500);

// 10. session status after revoke
r = await get(`/api/swig/status?owner=${ownerStr}&sessionKey=${sessionStr}`);
console.log("10. session after revoke:", JSON.stringify(r.json.session));

// 11. reclaim swig wallet balance back to owner
r = await post("/api/swig/prepare-reclaim", { owner: ownerStr });
console.log("11. prepare-reclaim:", r.status, r.json.nothingToReclaim ? "(nothing)" : `sweep ${r.json.sweepSol} SOL`);
if (!r.json.nothingToReclaim) {
  console.log("    reclaim submit:", JSON.stringify((await signAndSubmit(r.json.txBase64, owner)).json));
}

console.log("\nDONE.");
