"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { FieldCard } from "@/lib/browser-api";
import { fieldLabel, telemetryHref } from "@/components/monitor-panes";
import type { DiagnosisSignal } from "@/lib/pipeline";

type SourceState = "emitting" | "paused" | "waiting" | "ended";

function sourceState(
  field: FieldCard,
  playing: boolean,
  finished: boolean,
): SourceState {
  const hasData = (field.sparkline?.length ?? 0) > 0;
  if (finished && !playing) return "ended";
  if (playing && hasData) return "emitting";
  if (hasData) return "paused";
  return "waiting";
}

function alarmLevel(
  field: FieldCard,
  signals: DiagnosisSignal[],
): "red" | "yellow" | null {
  const key = `${field.source_id ?? ""}::${field.field_id}`;
  for (const signal of signals) {
    for (const top of signal.top_fields) {
      if (
        top.field_id === key ||
        top.field_id === field.field_id ||
        top.field_id.endsWith(`::${field.field_id}`)
      ) {
        return signal.level === "red" ? "red" : "yellow";
      }
    }
  }
  return null;
}

const STATE_LABEL: Record<SourceState, string> = {
  emitting: "Live",
  paused: "Paused",
  waiting: "Waiting",
  ended: "Ended",
};

export function DashboardSourcesMap({
  fields,
  playing,
  finished,
  tick,
  signals,
}: {
  fields: FieldCard[];
  playing: boolean;
  finished: boolean;
  tick: number;
  signals: DiagnosisSignal[];
}) {
  const grouped = fields.reduce<Record<string, FieldCard[]>>((acc, field) => {
    const group = field.source_file || field.source_id || "Sources";
    acc[group] ??= [];
    acc[group].push(field);
    return acc;
  }, {});

  if (fields.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">No configured sources yet.</p>
        <Link href="/telemetry" className="mt-2 inline-block text-sm underline-offset-2 hover:underline">
          Add sources on Telemetry
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Current sources</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {fields.length} channel{fields.length === 1 ? "" : "s"} · tick {tick}
            {playing ? " · streaming" : finished ? " · run ended" : " · idle"}
          </p>
        </div>
        <Link href="/telemetry" className="text-xs underline-offset-2 hover:underline">
          Open Telemetry
        </Link>
      </div>
      <div className="space-y-4">
        {Object.entries(grouped).map(([group, rows]) => (
          <div key={group}>
            <p className="mb-2 truncate font-mono text-[11px] text-muted-foreground">{group}</p>
            <div className="flex flex-wrap gap-2">
              {rows.map((field) => {
                const state = sourceState(field, playing, finished);
                const alarm = alarmLevel(field, signals);
                const href = telemetryHref(
                  `${field.source_id ?? ""}::${field.field_id}`,
                );
                return (
                  <Link
                    key={`${field.source_id}-${field.field_id}`}
                    href={href}
                    className={cn(
                      "group relative min-w-[7.5rem] rounded-lg border px-3 py-2 transition-colors hover:border-foreground/30",
                      state === "emitting" && "source-emitting border-emerald-500/40 bg-emerald-500/5",
                      state === "paused" && "border-border bg-muted/20",
                      state === "waiting" && "border-dashed border-border bg-background",
                      state === "ended" && "border-border bg-muted/10 opacity-80",
                      alarm === "red" && "ring-1 ring-red-400/50",
                      alarm === "yellow" && "ring-1 ring-amber-400/40",
                    )}
                  >
                    <p className="truncate font-mono text-xs">{fieldLabel(field.field_id)}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {STATE_LABEL[state]}
                      {alarm ? ` · ${alarm}` : ""}
                    </p>
                    {state === "emitting" && (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-x-2 -bottom-1 h-2 rounded-full bg-emerald-400/30 blur-md"
                      />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
