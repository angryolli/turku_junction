import { AppShell } from "@/components/app-shell";
import { ReportsView } from "@/components/reports-view";

export default function Page() {
  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-hidden">
        <ReportsView />
      </div>
    </AppShell>
  );
}
