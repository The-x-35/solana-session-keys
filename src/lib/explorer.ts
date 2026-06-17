import { CLUSTER } from "./env";

/** Solana Explorer links, always pinned to devnet. */

export function txUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
}

export function addressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=${CLUSTER}`;
}

export const FAUCET_URL = "https://faucet.solana.com/";

export function shorten(value: string, chars = 4): string {
  if (value.length <= chars * 2 + 1) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}
