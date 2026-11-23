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

/**
 * Idle sign-out after 15 seconds of inactivity so an unattended shared tablet
 * or counter terminal immediately locks back to the Sign-In screen.
 */
export const IDLE_LIMIT_MS = 15 * 1_000;

/**
 * What counts as the session still being in use.
 *
 * `touchstart`, `pointermove`, `click`, and `scroll` matter on a tablet: reading
 * down a long order list with a finger or moving across controls resets the
 * 15-second idle timer while someone is actively operating the screen.
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
    bootPos((_status: string, count: number) => {
      if (!cancelled) setQueueCount(count);
    })
      .then(() => !cancelled && setReady(true))
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setBootError(`${message}. Keep this browser's data intact and contact support; unsynced orders may be stored here.`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (nextUser: PosUser) => {
    signedOut.current = false;
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
    void endCloudSession();
  }, []);

  // Firebase keeps the session across reloads, so a refresh must not drop the
  // cashier back to a sign-in screen mid-shift.
  useEffect(() => {
    if (!ready) return;
    if (user || signedOut.current) {
      setResuming(false);
      return;
    }
    let cancelled = false;
    resumeStaffSession()
      .then((existing: PosUser | null) => {
        if (!cancelled && existing && !signedOut.current) void signIn(existing);
      })
      // Settled either way: we now know whether anyone is signed in, so the
      // sign-in screen is finally a truthful thing to show.
      .finally(() => {
        if (!cancelled) setResuming(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, user, signIn]);

  useEffect(() => {
    if (!user) return;

    let timer = window.setTimeout(signOut, IDLE_LIMIT_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(signOut, IDLE_LIMIT_MS);
    };

    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, reset);
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
