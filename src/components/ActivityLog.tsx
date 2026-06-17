"use client";

import { LogEntry } from "@/lib/activity";
import { addressUrl, shorten, txUrl } from "@/lib/explorer";

const KIND_STYLES: Record<LogEntry["kind"], string> = {
  info: "text-zinc-400",
  action: "text-sky-300",
  success: "text-emerald-300",
  error: "text-rose-300",
  warn: "text-amber-300",
};

const KIND_GLYPH: Record<LogEntry["kind"], string> = {
  info: "·",
  action: "→",
  success: "✓",
  error: "✕",
  warn: "!",
};

/** Reverse-chronological activity log with explorer links. */
export function ActivityLog({ entries }: { entries: LogEntry[] }) {
  return (
    <div className="rounded-xl border border-white/10 bg-panel/70">
      <div className="border-b border-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Activity log
      </div>
      <ul className="max-h-[28rem] divide-y divide-white/5 overflow-y-auto font-mono text-xs">
        {entries.length === 0 && (
          <li className="px-4 py-6 text-zinc-600">No activity yet.</li>
        )}
        {[...entries].reverse().map((e) => (
          <li key={e.id} className="px-4 py-2">
            <div className="flex items-start gap-2">
              <span className={`${KIND_STYLES[e.kind]} w-3 shrink-0`}>
                {KIND_GLYPH[e.kind]}
              </span>
              <div className="min-w-0">
                <span className={KIND_STYLES[e.kind]}>{e.message}</span>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-zinc-500">
                  {e.signature && (
                    <a
                      className="text-purple-300 hover:text-purple-200"
                      href={txUrl(e.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      tx {shorten(e.signature, 6)}
                    </a>
                  )}
                  {e.address && (
                    <a
                      className="text-purple-300 hover:text-purple-200"
                      href={addressUrl(e.address)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      acct {shorten(e.address, 6)}
                    </a>
                  )}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
