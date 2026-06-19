// Proves the destination LOCK: a token-destination-limited session can spend
// ONLY to the allowed recipient, and the chain rejects any other recipient.
// Run against a devnet-pointed server (SOLANA_RPC_URL=<devnet> npm run dev).
import web3 from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import os from "node:os";

const { Keypair, Transaction, Connection } = web3;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const envLocal = (k) => {
  try { return (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(new RegExp(`^${k}=(.+)$`, "m")) || [])[1]?.trim(); } catch { return undefined; }
};
const BEARER = process.env.BEARER || envLocal("SESSION_HELPER_BEARER");
const DEVNET = process.env.DEVNET_RPC || envLocal("NEXT_PUBLIC_RPC_URL") || "https://api.devnet.solana.com";
const kpPath = process.env.KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8"))));
const session = Keypair.generate();
const allowed = Keypair.generate();       // the ONLY address the session may fund
const conn = new Connection(DEVNET, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, b) { const r = await fetch(`${BASE_URL}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` }, body: JSON.stringify(b || {}) }); return { status: r.status, json: await r.json() }; }
async function get(p) { const r = await fetch(`${BASE_URL}${p}`, { headers: { authorization: `Bearer ${BEARER}` } }); return { status: r.status, json: await r.json() }; }
async function signSubmit(b64, signer) { const tx = Transaction.from(Buffer.from(b64, "base64")); tx.partialSign(signer); return post("/api/swig/submit", { signedTxBase64: tx.serialize({ requireAllSignatures: false }).toString("base64") }); }

const O = owner.publicKey.toBase58(), S = session.publicKey.toBase58(), A = allowed.publicKey.toBase58();
console.log("owner:", O, "\nsession:", S, "\nALLOWED dest:", A, "\n");

console.log("0. mint test token + fund owner 100");
const mint = await createMint(conn, owner, owner.publicKey, null, 6);
const m = mint.toBase58();
const ata = await getOrCreateAssociatedTokenAccount(conn, owner, mint, owner.publicKey);
await mintTo(conn, owner, mint, ata.address, owner, 100_000_000n);

let r = await post("/api/swig/prepare-create", { owner: O });
if (!r.json.alreadyExists) { await signSubmit(r.json.txBase64, owner); await sleep(2000); }
console.log("1. swig ready");

r = await post("/api/swig/prepare-fund", { owner: O, mint: m, amount: 30 });
await signSubmit(r.json.txBase64, owner); await sleep(2500);
console.log("2. funded swig 30");

// LOCK the session to `allowed` only, cap 10
r = await post("/api/swig/prepare-add-authority", { owner: O, mint: m, capAmount: 10, destination: A });
await signSubmit(r.json.txBase64, owner); await sleep(2500);
r = await post("/api/swig/prepare-open-session", { owner: O, sessionKey: S, durationSeconds: 300 });
await signSubmit(r.json.txBase64, owner); await sleep(2500);
console.log("3. session opened, locked to ALLOWED");

// spend to ALLOWED -> expect SUCCESS
r = await post("/api/swig/prepare-spend", { owner: O, sessionKey: S, to: A, mint: m, amount: 2 });
const okSpend = await signSubmit(r.json.txBase64, session);
console.log("4. spend 2 -> ALLOWED:", okSpend.status === 200 ? "✅ success" : "❌ FAILED");
if (okSpend.status !== 200) console.log("   FULL:", JSON.stringify(okSpend.json));
await sleep(2500);

// spend to a DIFFERENT address (owner) -> expect on-chain REJECTION
r = await post("/api/swig/prepare-spend", { owner: O, sessionKey: S, to: O, mint: m, amount: 2 });
const badSpend = await signSubmit(r.json.txBase64, session);
console.log("5. spend 2 -> OTHER (owner):", badSpend.status !== 200 ? "✅ rejected (lock holds)" : "❌ WENT THROUGH — lock failed");
console.log("   detail:", JSON.stringify(badSpend.json).slice(0, 200));

// cleanup
r = await post("/api/swig/prepare-revoke", { owner: O, sessionKey: S });
await signSubmit(r.json.txBase64, owner); await sleep(2000);
r = await post("/api/swig/prepare-reclaim", { owner: O, mint: m });
if (!r.json.nothingToReclaim) { await signSubmit(r.json.txBase64, owner); console.log("6. reclaimed", r.json.sweepAmount); }
console.log("\nDONE.");
