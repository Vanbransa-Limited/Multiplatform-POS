"use client";

import { ViewMount } from "@/components/view-mount";
import { CustomersView } from "@/ui/customers";

export default function Page() {
  return <ViewMount tab="customers" view={CustomersView} />;
}
