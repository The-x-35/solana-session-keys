import { PublicKey } from "@solana/web3.js";

/**
 * Central, validated access to public env config. Everything here is PUBLIC
 * (RPC URL, program IDs) — there are no secrets in this app. Ephemeral session
 * keypairs are generated at runtime and never persisted or read from env.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing env var ${name}. Copy .env.local.example to .env.local.`,
    );
  }
  return value.trim();
}

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL?.trim() ||
  "https://api.devnet.solana.com";

export const CLUSTER = "devnet" as const;

export const SWIG_PROGRAM_ID = new PublicKey(
  required("NEXT_PUBLIC_SWIG_PROGRAM_ID", process.env.NEXT_PUBLIC_SWIG_PROGRAM_ID),
);

export const GUM_SESSION_PROGRAM_ID = new PublicKey(
  required(
    "NEXT_PUBLIC_GUM_SESSION_PROGRAM_ID",
    process.env.NEXT_PUBLIC_GUM_SESSION_PROGRAM_ID,
  ),
);

export const GUM_TARGET_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_GUM_TARGET_PROGRAM_ID?.trim() ||
    process.env.NEXT_PUBLIC_GUM_SESSION_PROGRAM_ID?.trim() ||
    "KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5",
);
