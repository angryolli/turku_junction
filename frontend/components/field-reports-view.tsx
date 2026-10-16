"use client";

import { useEffect, useMemo, useState } from "react";
import { browserGet } from "@/lib/browser-api";
import { IDLE_AGENT, type SensorNote, type SystemAgentStatus } from "@/components/monitor-panes";

type LogEntry = {
  ts: string;
  type: string;
  payload: {
    step?: string;
    fields?: unknown[];
  };
};

function fieldsFromSensors(
  sensors: Record<string, SensorNote>,
  mode: "understanding" | "quality",
) {
  const rows: Record<string, unknown>[] = [];
  for (const note of Object.values(sensors)) {
    if (mode === "understanding" && note.understanding) {
      rows.push(note.understanding);
    }
    if (mode === "quality" && note.quality) {
      rows.push(note.quality);
    }
  }
  return rows;
}

function latestLogFields(entries: LogEntry[], step: string) {
  for (const entry of entries) {
    if (entry.payload?.step === step && Array.isArray(entry.payload.fields)) {
      return entry.payload.fields as Record<string, unknown>[];
    }
  }
  return [];
}

function FieldBlock({ row }: { row: Record<string, unknown> }) {
  const fieldId = String(row.field_id ?? "—");
  return (
    <li className="rounded-lg border border-border p-3">
      <p className="font-mono text-xs text-foreground">{fieldId}</p>
      <dl className="mt-2 space-y-1 text-sm">
        {Object.entries(row).map(([key, value]) => {
          if (key === "field_id") return null;
          return (
            <div key={key} className="grid gap-1 sm:grid-cols-[7rem_1fr]">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="font-mono text-xs wrap-break-word">{String(value)}</dd>
            </div>
          );
        })}
      </dl>
    </li>
  );
}

export function FieldReportsView({ mode }: { mode: "understanding" | "quality" }) {
  const [agent, setAgent] = useState<SystemAgentStatus>(IDLE_AGENT);
  const [logFields, setLogFields] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    let on = true;
    async function load() {
      try {
        const [agentRes, logRes] = await Promise.all([
          fetch("/api/system-agent").then((r) => r.json() as Promise<SystemAgentStatus>),
          browserGet<{ entries: LogEntry[] }>("/decision-log"),
        ]);
        if (!on) return;
        setAgent({ ...IDLE_AGENT, ...agentRes, sensors: agentRes.sensors ?? {} });
        setLogFields(
          latestLogFields(logRes.entries ?? [], mode === "understanding" ? "understanding" : "quality"),
        );
      } catch {
        if (on) {
          setAgent(IDLE_AGENT);
          setLogFields([]);
        }
      }
    }
    void load();
    return () => {
      on = false;
    };
  }, [mode]);

  const liveFields = useMemo(
    () => fieldsFromSensors(agent.sensors ?? {}, mode),
    [agent.sensors, mode],
  );
  const fields = liveFields.length > 0 ? liveFields : logFields;
  const payload = { fields };

  return (
    <div className="space-y-4">
      {fields.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          Launch the system agent on the dashboard to populate this report for the current run.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {fields.map((row) => (
              <FieldBlock key={String(row.field_id)} row={row} />
            ))}
          </ul>
          <pre className="overflow-x-auto rounded-xl border border-border bg-card p-4 font-mono text-[11px] text-muted-foreground">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}
