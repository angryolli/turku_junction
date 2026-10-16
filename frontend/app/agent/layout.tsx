import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { ChatView } from "@/components/chat-view";

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="h-full min-h-0">
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading agent…</p>}>
          <ChatView />
        </Suspense>
        {children}
      </div>
    </AppShell>
  );
}
