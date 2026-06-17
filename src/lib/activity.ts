/** Shared activity-log types used by both demos. */

export type LogKind = "info" | "action" | "success" | "error" | "warn";

export interface LogEntry {
  id: number;
  kind: LogKind;
  message: string;
  /** Optional transaction signature → renders an explorer link. */
  signature?: string;
  /** Optional account/address → renders an explorer link. */
  address?: string;
  at: number;
}

let counter = 0;

export function makeEntry(
  kind: LogKind,
  message: string,
  extra?: { signature?: string; address?: string },
): LogEntry {
  counter += 1;
  return {
    id: counter,
    kind,
    message,
    signature: extra?.signature,
    address: extra?.address,
    at: Date.now(),
  };
}
