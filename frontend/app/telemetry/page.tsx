import { AppShell } from "@/components/app-shell";
import { AnalysisView } from "@/components/analysis-view";

export default function Page() {
  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-hidden">
        <AnalysisView />
      </div>
    </AppShell>
  );
}
