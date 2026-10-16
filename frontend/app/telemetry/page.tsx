import { AppShell } from "@/components/app-shell";
import { TelemetryView } from "@/components/telemetry-view";

export default function Page() {
  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-hidden">
        <TelemetryView />
      </div>
    </AppShell>
  );
}
