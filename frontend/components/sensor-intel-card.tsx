"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { telemetryHref, type SensorNote } from "@/components/monitor-panes";

const SCALE = ["Untrusted", "Poor", "Fair", "Good", "Excellent"] as const;

const SCALE_COLOR = {
  Untrusted: { bar: "bg-red-400", dim: "bg-red-400/20", text: "text-red-300" },
  Poor: { bar: "bg-orange-400", dim: "bg-orange-400/20", text: "text-orange-300" },
  Fair: { bar: "bg-amber-400", dim: "bg-amber-400/20", text: "text-amber-300" },
  Good: { bar: "bg-lime-400", dim: "bg-lime-400/20", text: "text-lime-300" },
  Excellent: { bar: "bg-emerald-400", dim: "bg-emerald-400/20", text: "text-emerald-300" },
} as const;

function adjectiveIndex(value: string) {
  const i = SCALE.findIndex((row) => row.toLowerCase() === value.toLowerCase());
  return i >= 0 ? i : 2;
}

function confidenceTone(confidence: number) {
  if (confidence >= 0.7) return "text-emerald-400";
  if (confidence >= 0.45) return "text-amber-300";
  return "text-orange-300";
}

function ConfidenceBar({ value }: { value: number }) {
  return (
    <div className="flex gap-1">
      {[0, 1, 2, 3, 4].map((index) => {
        const filled = value >= (index + 1) / 5;
        return (
          <span
            key={index}
            className={cn("h-1 flex-1 rounded-full", filled ? "bg-primary/80" : "bg-muted")}
          />
        );
      })}
    </div>
  );
}

function QualityBar({ levelIndex }: { levelIndex: number }) {
  return (
    <div className="flex gap-1">
      {SCALE.map((label, index) => (
        <span
          key={label}
          title={label}
          className={cn(
            "h-1 flex-1 rounded-full",
            index <= levelIndex ? SCALE_COLOR[label].bar : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

export function noteForField(
  sensors: Record<string, SensorNote> | undefined,
  sourceId: string,
  fieldId: string,
): SensorNote | null {
  if (!sensors) return null;
  const key = `${sourceId}::${fieldId}`;
  if (sensors[key]) return sensors[key];
  if (sensors[fieldId]) return sensors[fieldId];
  const hit = Object.entries(sensors).find(([id]) => id.endsWith(`::${fieldId}`));
  return hit?.[1] ?? null;
}

export function SensorIntelCard({
  sourceId,
  fieldId,
  sourceFile,
  note,
  compact = false,
  embedded = false,
  showQuality = true,
  showUnderstanding = true,
}: {
  sourceId: string;
  fieldId: string;
  sourceFile?: string;
  note: SensorNote | null;
  compact?: boolean;
  embedded?: boolean;
  showQuality?: boolean;
  showUnderstanding?: boolean;
}) {
  const understanding = note?.understanding;
  const quality = note?.quality;
  const adj = quality?.adjective ?? "Fair";
  const adjI = adjectiveIndex(adj);
  const href = telemetryHref(`${sourceId}::${fieldId}`);
  const guessConfidence = understanding?.confidence ?? 0;

  return (
    <article
      className={cn(
        !embedded && "rounded-xl border border-border bg-card",
        compact ? "p-3" : embedded ? "p-0" : "p-4",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={href}
            className="truncate font-mono text-sm underline-offset-2 hover:underline"
          >
            {fieldId}
          </Link>
          <p className="truncate text-[11px] text-muted-foreground">
            {sourceFile || sourceId || "—"}
          </p>
        </div>
        {quality && showQuality && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px]",
              SCALE_COLOR[SCALE[adjI]].text,
              SCALE_COLOR[SCALE[adjI]].dim,
            )}
          >
            {quality.adjective}
          </span>
        )}
      </div>

      {showUnderstanding && (
        <section className="mt-3 space-y-2">
          {understanding ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                  Likely sensor
                </p>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px]",
                    confidenceTone(guessConfidence),
                  )}
                >
                  {(guessConfidence * 100).toFixed(0)}% confident
                </span>
              </div>
              <p className="text-sm leading-snug text-foreground">
                {understanding.guess || "No guess yet."}
              </p>
              {understanding.role && (
                <p className="text-[11px] text-muted-foreground capitalize">
                  {understanding.role}
                </p>
              )}
              <ConfidenceBar value={guessConfidence} />
              {understanding.observations && (
                <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
                  <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    Right now
                  </p>
                  <p className="mt-1 text-sm leading-snug text-muted-foreground">
                    {understanding.observations}
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Launch the system agent to guess what this channel measures and summarize the stream.
            </p>
          )}
        </section>
      )}

      {showQuality && (
        <section className={cn("space-y-2", showUnderstanding && "mt-3")}>
          <h4 className="text-[10px] tracking-wide text-muted-foreground uppercase">Quality</h4>
          {quality ? (
            <div className="space-y-2 text-sm">
              <p>
                {quality.faulty ? "Sensor looks faulty." : "Sensor does not look faulty."}
                {quality.issue && quality.issue !== "none" ? ` ${quality.issue}.` : ""}
              </p>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className={SCALE_COLOR[SCALE[adjI]].text}>{quality.adjective}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {(quality.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <QualityBar levelIndex={adjI} />
              </div>
              {quality.summary && <p className="text-muted-foreground">{quality.summary}</p>}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Launch the system agent to judge sensor quality. This is not a process alarm.
            </p>
          )}
        </section>
      )}
    </article>
  );
}

export function SensorIntelGrid({
  fields,
  sensors,
  mode = "both",
}: {
  fields: Array<{ source_id?: string; field_id: string; source_file?: string }>;
  sensors: Record<string, SensorNote>;
  mode?: "understanding" | "quality" | "both";
}) {
  if (fields.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        Add sources on Telemetry, then play the stream.
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const sourceId = field.source_id ?? "";
        const key = `${sourceId}::${field.field_id}`;
        return (
          <SensorIntelCard
            key={key}
            sourceId={sourceId}
            fieldId={field.field_id}
            sourceFile={field.source_file}
            note={noteForField(sensors, sourceId, field.field_id)}
            showUnderstanding={mode === "understanding" || mode === "both"}
            showQuality={mode === "quality" || mode === "both"}
          />
        );
      })}
    </div>
  );
}
