"use client";

import { ViewMount } from "@/components/view-mount";
import { TabManagementView } from "@/ui/tab-management";

export default function Page() {
  return <ViewMount tab="tabs" view={TabManagementView} />;
}
