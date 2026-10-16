"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { SimulationProvider } from "@/components/simulation-context";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SimulationProvider>
      <div className="flex h-svh overflow-hidden bg-background">
        <AppSidebar />
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {children}
        </div>
      </div>
    </SimulationProvider>
  );
}
