"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { COMMAND_CENTER_PAGES } from "@/app/lib/nav";

const ICON: Record<string, string> = {
  "/command": "⌂",
  "/command/clients": "▦",
  "/command/calls": "☎",
  "/command/problems": "!",
};

function active(path: string, href: string) {
  return href === "/command" ? path === "/command" : path === href || path.startsWith(href + "/");
}

export default function CommandNav({ admin, name }: { admin: boolean; name: string }) {
  const path = usePathname() || "/command";
  const [more, setMore] = useState(false);
  const pages = COMMAND_CENTER_PAGES.filter((p) => admin || !p.adminOnly);
  const bar = pages.filter((p) => p.bar);
  const rest = pages.filter((p) => !p.bar);
  const moreActive = rest.some((p) => active(path, p.href));

  return (
    <>
      <header className="cc-top">
        <div className="cc-top-row">
          <Link href="/command" className="cc-brand">
            <small>Wing</small>Command Center
          </Link>
          <div className="cc-who">
            <span>{name}</span>
            {admin ? <Link href="/" className="cc-btn small">OS</Link> : null}
            <a href="/api/command/logout" className="cc-btn small">Sign out</a>
          </div>
        </div>
        <nav className="cc-tabs" aria-label="Command Center">
          {pages.map((p) => (
            <Link key={p.href} href={p.href} className="cc-tab" aria-current={active(path, p.href) ? "page" : undefined}>
              {p.label}
            </Link>
          ))}
        </nav>
      </header>

      {more ? (
        <nav className="cc-more" aria-label="More screens">
          {rest.map((p) => (
            <Link key={p.href} href={p.href} onClick={() => setMore(false)}>
              {p.label}
            </Link>
          ))}
        </nav>
      ) : null}
      <nav className="cc-bar" aria-label="Command Center">
        {bar.map((p) => (
          <Link key={p.href} href={p.href} aria-current={active(path, p.href) ? "page" : undefined} onClick={() => setMore(false)}>
            <span className="cc-ico" aria-hidden="true">{ICON[p.href] ?? "•"}</span>
            {p.short ?? p.label}
          </Link>
        ))}
        <button type="button" aria-expanded={more || moreActive} onClick={() => setMore((m) => !m)}>
          <span className="cc-ico" aria-hidden="true">≡</span>
          More
        </button>
      </nav>
    </>
  );
}
