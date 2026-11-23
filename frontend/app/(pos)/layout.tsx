"use client";

import type { ReactNode } from "react";

import { SignIn } from "@/components/sign-in";
import { PosSessionProvider, usePosSession } from "@/components/pos-session";
import { Sidebar } from "@/components/sidebar";
import { MobileNav } from "@/components/mobile-nav";

/**
 * The POS shell. Until a PIN is accepted the tablet lock screen is the only
 * thing rendered, exactly as the original app started locked.
 */
/**
 * Shown while the session is still being worked out.
 *
 * Deliberately not the sign-in screen: restoring a session loads the Firebase
 * SDK and waits on auth state, and putting a login form in front of an operator
 * who is already signed in made every load and every remount look like a
 * sign-out.
 */
function BootScreen() {
  return (
    <div className="pos-boot" role="status" aria-live="polite">
      <div className="pos-boot-mark">V</div>
      <div className="pos-boot-bar"><span /></div>
      <p>Restoring your session…</p>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { ready, resuming, bootError, user } = usePosSession();

  if (bootError) {
    return (
      <div
        style={{ position: "fixed", top: 0, left: 0, width: "100%", background: "#f43f5e", color: "#fff", padding: 12, textAlign: "center", zIndex: 99999, fontSize: 12, fontWeight: "bold" }}
      >
        {`Database Initialization Error: ${bootError}`}
      </div>
    );
  }

  // Only once we know nobody is signed in is the sign-in screen the truth.
  if (!ready || resuming) return <BootScreen />;
  if (!user) return <SignIn />;

  return (
    <div id="pos-shell">
      <Sidebar />
      <main className="app-main-content">{children}</main>
      <MobileNav />
    </div>
  );
}

export default function PosLayout({ children }: { children: ReactNode }) {
  return (
    <PosSessionProvider>
      <Shell>{children}</Shell>
    </PosSessionProvider>
  );
}
