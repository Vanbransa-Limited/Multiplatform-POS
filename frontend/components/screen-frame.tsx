"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { canViewTab, defaultTabForRole } from "@/navigation";
import { showNotification } from "@/context";

import { usePosSession } from "./pos-session";

/**
 * Wrapper every screen sits in, ported or not.
 *
 * Owns the role check that switchTab() used to perform, and renders the
 * `#view-<tab>` section the stylesheet targets.
 */
export function useScreenGuard(tab: string) {
  const router = useRouter();
  const { ready, user } = usePosSession();
  const allowed = user ? canViewTab(user.role, tab) : false;

  useEffect(() => {
    if (!ready || !user || allowed) return;
    const target = defaultTabForRole(user.role);
    if (tab !== "till") {
      showNotification("Redirected to your assigned workspace module.", "warning");
    }
    router.replace(`/${target}`);
  }, [ready, user, allowed, router, tab]);

  return { ready, user, allowed };
}

export function ScreenFrame({ tab, children }: { tab: string; children: ReactNode }) {
  const { ready, user, allowed } = useScreenGuard(tab);

  return (
    <section id={`view-${tab}`} className="tab-view active">
      {ready && user && allowed ? children : null}
    </section>
  );
}
