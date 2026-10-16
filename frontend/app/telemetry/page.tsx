import { AppShell } from "@/components/app-shell";
import { AntibiogramView } from "@/components/antibiogram-view";

export default function Page() {
  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-hidden">
        <AntibiogramView />
      </div>
    </AppShell>
  );
}
