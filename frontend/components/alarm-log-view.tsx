"use client";

import { useEffect, useMemo, useState } from "react";
import { alarmsOldestFirst } from "@/components/monitor-panes";
import { browserGet } from "@/lib/browser-api";
import type { DiagnosisSignal, DiagnosisSnapshot } from "@/lib/pipeline";

export function AlarmLogView({ runId }: { runId?: string }) {
  const [signals, setSignals] = useState<DiagnosisSignal[]>([]);

  useEffect(() => {
    let on = true;
    async function load() {
      try {
        if (runId) {
          const data = await browserGet<{ alarms: DiagnosisSignal[] }>(
            `/simulation/runs/${runId}`,
          );
          if (on) setSignals(data.alarms ?? []);
          return;
        }
        const data = await browserGet<DiagnosisSnapshot>("/diagnosis");
        if (on) setSignals(data.signals ?? data.events ?? []);
      } catch {
        if (on) setSignals([]);
      }
    }
    void load();
    return () => {
      on = false;
    };
  }, [runId]);

  const orderedSignals = useMemo(() => alarmsOldestFirst(signals), [signals]);

  return (
    <ul className="space-y-2 font-mono text-xs">
      {orderedSignals.length === 0 && (
        <li className="rounded-md border border-border p-3 text-muted-foreground">
          No alarms in this run.
        </li>
      )}
      {orderedSignals.map((row) => (
        <li key={row.id} className="rounded-md border border-border p-3">
          <p>
            {row.id} · {row.level} · tick {row.tick} · score {row.score.toFixed(2)} · z{" "}
            {row.z.toFixed(2)}
            {row.reason ? ` · ${row.reason}` : ""}
          </p>
          <p className="text-muted-foreground">{row.evidence}</p>
          {row.top_fields?.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
              {row.top_fields.map((field) => (
                <li key={field.field_id}>
                  {field.field_id} · score {field.score.toFixed(2)}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
