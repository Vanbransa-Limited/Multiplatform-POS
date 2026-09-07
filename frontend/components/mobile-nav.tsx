"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { mobileNav } from "@/navigation";
import { showNotification } from "@/context";

import { usePosSession } from "./pos-session";

/**
 * Bottom navigation for phones and tablets.
 *
 * The sidebar is a desktop shape: on a phone it either eats the screen or, when
 * folded flat, turns into a row of collapsed accordions nobody can aim at. This
 * replaces it below the desktop breakpoint with a fixed bar of large targets -
 * the few destinations a role actually reaches, plus More for the rest, so the
 * bar keeps the same shape for everyone.
 */
export function MobileNav() {
  const pathname = usePathname();
  const { user, online, setOnline, signOut } = usePosSession();
  const [sheetOpen, setSheetOpen] = useState(false);
  const activeTab = pathname.split("/").filter(Boolean)[0] ?? "";

  // Following any link closes the sheet, so it never covers what you opened.
  useEffect(() => setSheetOpen(false), [pathname]);

  if (!user) return null;
  const { primary, overflow } = mobileNav(user.role);
  const inOverflow = overflow.some((item) => item.tab === activeTab);

  return (
    <>
      {sheetOpen ? (
        <div className="mnav-scrim" role="presentation" onClick={() => setSheetOpen(false)}>
          <div className="mnav-sheet" role="dialog" aria-label="All modules" onClick={(event) => event.stopPropagation()}>
            <div className="mnav-sheet-grab" aria-hidden="true" />

            <div className="mnav-sheet-user">
              <div className="mnav-avatar">{user.name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div>
              <div>
                <div className="mnav-sheet-name">{user.name}</div>
                <div className="mnav-sheet-role">{user.role}</div>
              </div>
              <button
                type="button"
                className={`status-badge ${online ? "online" : "offline"}`}
                onClick={() => {
                  const next = !online;
                  setOnline(next);
                  showNotification(next ? "Back online. Draining outbox queue..." : "Simulating Offline Mode. Outbox queue will hold transactions.", next ? "success" : "warning");
                }}
              >
                <span className="badge-dot" />
                <span className="badge-text">{online ? "Online" : "Offline"}</span>
              </button>
            </div>

            {overflow.length > 0 ? (
              <div className="mnav-sheet-grid">
                {overflow.map((item) => (
                  <Link key={item.tab} href={`/${item.tab}`} className={`mnav-sheet-item ${activeTab === item.tab ? "active" : ""}`}>
                    <span className="mnav-sheet-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="mnav-sheet-empty">Everything you can open is already on the bar.</p>
            )}

            <button type="button" className="mnav-signout" onClick={signOut}>⏻ Sign out</button>
          </div>
        </div>
      ) : null}

      <nav className="mobile-nav" aria-label="Main">
        {primary.map((item) => (
          <Link key={item.tab} href={`/${item.tab}`} className={`mnav-btn ${activeTab === item.tab ? "active" : ""}`}>
            <span className="mnav-icon">{item.icon}</span>
            <span className="mnav-label">{item.short ?? item.label}</span>
          </Link>
        ))}
        <button
          type="button"
          className={`mnav-btn ${inOverflow || sheetOpen ? "active" : ""}`}
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((open) => !open)}
        >
          <span className="mnav-icon">☰</span>
          <span className="mnav-label">More</span>
        </button>
      </nav>
    </>
  );
}
