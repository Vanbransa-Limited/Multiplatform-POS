"use client";

import { ViewMount } from "@/components/view-mount";
import { PrintStationView } from "@/ui/print-station";

export default function Page() {
  return <ViewMount tab="print-station" view={PrintStationView} />;
}
