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
      <div className="pos-boot pos-startup-problem" role="alert">
        <div className="pos-boot-mark" aria-hidden="true">V</div>
        <h1>Unable to open the till</h1>
        <p>{bootError}</p>
        <p>Saved orders remain on this device.</p>
        <button type="button" className="primary-btn" onClick={() => window.location.reload()}>Try again</button>
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
