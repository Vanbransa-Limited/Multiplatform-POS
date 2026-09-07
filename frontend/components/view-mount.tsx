"use client";

import { useEffect, useRef } from "react";

import { showNotification } from "@/context";

import { useScreenGuard } from "./screen-frame";

type ViewClass = new (container: HTMLElement) => { load: () => Promise<void> | void; dispose?: () => void };

/**
 * Mounts one of the original view classes into this route.
 *
 * A screen keeps rendering through its own code until it has been ported to
 * JSX and proven against visual/baselines/<tab>.png. Porting a screen means
 * swapping this for the new component in that one page file.
 */
export function ViewMount({ tab, view: View }: { tab: string; view: ViewClass }) {
  const ref = useRef<HTMLElement | null>(null);
  const loadedFor = useRef<HTMLElement | null>(null);
  const { ready, user, allowed } = useScreenGuard(tab);

  useEffect(() => {
    const container = ref.current;
    if (!ready || !user || !allowed || !container) return;
    // React StrictMode invokes effects twice in development. The element is
    // reused across that pair, so keying on it renders the view exactly once.
    if (loadedFor.current === container) return;
    loadedFor.current = container;

    try {
      const instance = new View(container);
      Promise.resolve(instance.load()).catch(() => showNotification('This module could not be opened.', 'error'));
      return () => { instance.dispose?.(); loadedFor.current = null; };
    } catch (error) {
      console.error(`Failed to load the ${tab} view:`, error);
      showNotification("This module could not be opened. Check the console for details.", "error");
    }
  }, [ready, user, allowed, View, tab]);

  return <section ref={ref} id={`view-${tab}`} className="tab-view active" />;
}
