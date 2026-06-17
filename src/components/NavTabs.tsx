"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Overview" },
  { href: "/swig", label: "Swig" },
  { href: "/magicblock", label: "MagicBlock / Gum" },
];

export function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 rounded-xl border border-white/10 bg-panel/70 p-1 text-sm">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-lg px-3 py-1.5 transition ${
              active
                ? "bg-purple-500/30 text-white"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
