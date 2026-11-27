"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  bootPos,
  endCloudSession,
  establishCloudSession,
  reportStockAlerts,
  resumeStaffSession,
} from "@/boot";
import { ACTIVITY_EVENT, state } from "@/context";
import { watchStartup } from "@/services/startup-watch";

const STARTUP_PROBLEM = "The till could not finish opening. Check your connection and try again.";

/**
 * Idle sign-out so an unattended shared tablet locks back to the Sign-In screen.
 *
 * Not seconds: reading a bill, counting change or waiting while a customer
 * approves an M-Pesa prompt on their phone all look idle, and 15 seconds
 * signed cashiers out in the middle of a sale.
 */
export const IDLE_LIMIT_MS = 5 * 60 * 1_000;

/**
 * What counts as the session still being in use.
 *
 * `touchstart`, `pointermove`, `click`, and `scroll` matter on a tablet: reading
 * down a long order list with a finger or moving across controls resets the
 * idle timer while someone is actively operating the screen.
 *
 * ACTIVITY_EVENT is not a human touching the screen at all - it is a module
 * saying it is deliberately doing work, which is the only reason an untouched
 * print station stays signed in.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'click', 'keydown', 'wheel', 'touchstart', 'touchmove', 'scroll', ACTIVITY_EVENT] as const;

type PosUser = {
  id: string;
  name: string;
  role: string;
  [key: string]: unknown;
};

type PosSessionValue = {
  ready: boolean;
  /**
   * True while the app is still working out who is signed in.
   *
   * Restoring a session dynamically imports the Firebase SDK and then waits on
   * auth state, which is seconds on a slow link. Treating "not signed in yet"
   * as "signed out" put the sign-in screen in front of the operator every time
   * that happened, so callers must wait for this to clear before concluding
   * anything from a null user.
   */
  resuming: boolean;
  bootError: string | null;
  user: PosUser | null;
  queueCount: number;
  online: boolean;
  signIn: (user: PosUser) => Promise<void>;
  signOut: () => void;
  setOnline: (value: boolean) => void;
};

const PosSessionContext = createContext<PosSessionValue | null>(null);

export function usePosSession() {
  const value = useContext(PosSessionContext);
  if (!value) throw new Error("usePosSession must be used inside PosSessionProvider.");
  return value;
}

export function PosSessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [user, setUser] = useState<PosUser | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [online, setOnlineState] = useState(true);
  const [resuming, setResuming] = useState(true);
  // An explicit sign-out must not be undone by the resume below racing the
  // Firebase sign-out it just started.
  const signedOut = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const stop = watchStartup(bootPos((_status: string, count: number) => {
      if (!cancelled) setQueueCount(count);
    }), {
      onReady: () => { setBootError(null); setReady(true); },
      onError: (error: unknown) => { console.error('POS startup did not finish', error); setBootError(STARTUP_PROBLEM); },
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const signIn = useCallback(async (nextUser: PosUser) => {
    signedOut.current = false;
    try { localStorage.removeItem('pos_sign_out_pending'); } catch { /* nothing pending */ }
    state.currentUser = nextUser;
    setUser(nextUser);
    // Opening the shift and the stock sweep are both advisory; neither may
    // block the operator from reaching the till.
    void establishCloudSession();
    setTimeout(() => void reportStockAlerts(), 3000);
  }, []);

  const signOut = useCallback(() => {
    signedOut.current = true;
    setResuming(false);
    state.currentUser = null;
    setUser(null);
    // The screen locks now; the cloud session stays until held orders upload,
    // and is kept if somebody signs back in meanwhile.
    try { localStorage.setItem('pos_sign_out_pending', '1'); } catch { /* reload may resume */ }
    void Promise.resolve(state.syncManager?.drainBeforeSignOut())
      .catch(() => {})
      .finally(() => { if (signedOut.current) void endCloudSession(); });
  }, []);

  // Firebase keeps the session across reloads, so a refresh must not drop the
  // cashier back to a sign-in screen mid-shift.
  useEffect(() => {
    if (!ready) return;
    if (user || signedOut.current) {
      setResuming(false);
      return;
    }
    return watchStartup(resumeStaffSession(), {
      onReady: (existing: PosUser | null) => {
        if (existing && !signedOut.current) void signIn(existing);
        setBootError(null);
        setResuming(false);
      },
      onError: (error: unknown) => {
        console.error('POS session restore did not finish', error);
        setBootError(STARTUP_PROBLEM);
        setResuming(false);
      },
    });
  }, [ready, user, signIn]);

  useEffect(() => {
    // The bar till stays with the barman all shift, so it never locks itself.
    if (!user || user.role === 'Bar Staff') return;

    let timer = window.setTimeout(signOut, IDLE_LIMIT_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(signOut, IDLE_LIMIT_MS);
    };

    // Capture, because scroll does not bubble: scrolling the cart, the order
    // list or a bill panel never reached a window listener, so it looked idle.
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, reset, { passive: true, capture: true });
    return () => {
      window.clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, reset, { capture: true });
    };
  }, [user, signOut]);

  const setOnline = useCallback((value: boolean) => {
    setOnlineState(value);
    if (state.syncManager) {
      state.syncManager.setConnectionStatus(value ? "ONLINE" : "OFFLINE");
      if (value) state.syncManager.syncOutbox();
    }
  }, []);

  const value = useMemo<PosSessionValue>(
    () => ({ ready, resuming, bootError, user, queueCount, online, signIn, signOut, setOnline }),
    [ready, resuming, bootError, user, queueCount, online, signIn, signOut, setOnline],
  );

  return <PosSessionContext.Provider value={value}>{children}</PosSessionContext.Provider>;
}
