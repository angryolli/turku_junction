"use client";

import { Suspense } from "react";
import { DataSourcesView } from "@/components/data-sources-view";

export function TelemetryView() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-4 py-2">
        <p className="text-xs tracking-wide text-muted-foreground uppercase">Telemetry</p>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={null}>
          <DataSourcesView />
        </Suspense>
      </div>
    </div>
  );
}
