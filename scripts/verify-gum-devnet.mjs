// Headless proof of the Gum session-token lifecycle against real devnet.
// The browser hook (useSessionKeyManager) just wraps these same on-chain
// program calls; here we drive them directly via the core SDK's anchor program.
import web3 from "@solana/web3.js";
const { Connection, Keypair, PublicKey } = web3;
import anchor from "@coral-xyz/anchor";
import gum from "@magicblock-labs/gum-sdk";
const { SessionTokenManager } = gum;
import { readFileSync } from "node:fs";
import os from "node:os";

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
const kpPath = process.env.KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8"))));
console.log("payer:", payer.publicKey.toBase58());

const wallet = new anchor.Wallet(payer);
const mgr = new SessionTokenManager(wallet, c);
const program = mgr.program;
console.log("session program:", program.programId.toBase58());

const ephemeral = Keypair.generate();
const targetProgram = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
const validUntil = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // +1h

// 1. create session (top_up=false, no lamports). Ephemeral key co-signs.
const builder = program.methods
  .createSession(false, validUntil, null)
  .accounts({
    targetProgram,
    sessionSigner: ephemeral.publicKey,
    authority: payer.publicKey,
  });
const { sessionToken } = await builder.pubkeys();
console.log("session token PDA:", sessionToken.toBase58());
const createSig = await builder.signers([ephemeral]).rpc();
console.log("1. createSession:", createSig, "✅");

// 2. inspect / decode the on-chain SessionToken
const info = await c.getAccountInfo(sessionToken, "confirmed");
console.log("2. on-chain account exists:", !!info, "| owner:", info?.owner.toBase58(),
  "| ownedByGum:", info?.owner.equals(program.programId));
const decoded = await mgr.get(sessionToken);
console.log("   authority:", decoded.authority.toBase58());
console.log("   targetProgram (scope):", decoded.targetProgram.toBase58());
console.log("   sessionSigner:", decoded.sessionSigner.toBase58());
console.log("   validUntil:", new Date(decoded.validUntil.toNumber() * 1000).toISOString());

// 3. sign a message with the ephemeral session key (no owner involvement)
const msgSig = anchor.utils.bytes.bs58.encode(
  (await import("tweetnacl")).default.sign.detached(
    new TextEncoder().encode("session action"), ephemeral.secretKey,
  ),
);
console.log("3. session key signed a message ✅ sig:", msgSig.slice(0, 16) + "…");

// 4. revoke -> closes the token account
const revokeSig = await program.methods
  .revokeSession()
  .accounts({ sessionToken, authority: payer.publicKey })
  .rpc();
console.log("4. revokeSession:", revokeSig, "✅");
const after = await c.getAccountInfo(sessionToken, "confirmed");
console.log("5. token account after revoke:", after === null ? "CLOSED ✅" : "still exists ❌");

console.log("\nDONE — explorer cluster=devnet for each signature above.");
