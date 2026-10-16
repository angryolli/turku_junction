import { AppShell } from "@/components/app-shell";
import { DashboardView } from "@/components/dashboard-view";

export default function Page() {
  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-hidden">
        <DashboardView />
      </div>
    </AppShell>
  );
}
