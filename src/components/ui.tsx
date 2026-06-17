"use client";

import { ReactNode } from "react";

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-white/10 bg-panel/70 p-5 ${className}`}>
      {children}
    </div>
  );
}

export function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <Panel>
      <div className="mb-3 flex items-center gap-2">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
            done
              ? "bg-emerald-500/30 text-emerald-200"
              : "bg-purple-500/30 text-purple-100"
          }`}
        >
          {done ? "✓" : n}
        </span>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <div className="space-y-3 text-sm text-zinc-300">{children}</div>
    </Panel>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "ghost";
}) {
  const styles = {
    primary: "bg-purple-600 hover:bg-purple-500 text-white",
    danger: "bg-rose-600/80 hover:bg-rose-500 text-white",
    ghost: "border border-white/15 text-zinc-200 hover:bg-white/5",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  suffix,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type={type}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-40 rounded-lg border border-white/15 bg-black/30 px-3 py-1.5 text-sm text-white outline-none focus:border-purple-400/60 disabled:opacity-40"
        />
        {suffix && <span className="text-xs text-zinc-500">{suffix}</span>}
      </div>
    </label>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-100/90">
      {children}
    </div>
  );
}
