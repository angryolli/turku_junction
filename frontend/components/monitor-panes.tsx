"use client";

import {
  Activity,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  HelpCircle,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMarkdown } from "@/components/chat-markdown";
import { cn } from "@/lib/utils";
import type { DiagnosisSignal, DiagnosisSnapshot } from "@/lib/pipeline";

export function alarmsOldestFirst(signals: DiagnosisSignal[]) {
  return [...signals].sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    return a.created_at.localeCompare(b.created_at);
  });
}

export function fieldLabel(id: string) {
  const sep = id.indexOf("::");
  return sep >= 0 ? id.slice(sep + 2) : id;
}

export function telemetryHref(fieldId: string) {
  const sep = fieldId.indexOf("::");
  const source = sep >= 0 ? fieldId.slice(0, sep) : "";
  const field = sep >= 0 ? fieldId.slice(sep + 2) : fieldId;
  const q = new URLSearchParams();
  if (source) q.set("source", source);
  q.set("field", field);
  return `/telemetry?${q.toString()}`;
}

export function fmt(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(3);
}

/** Metric chips for an alarm — avoid showing z-score `score/k` on v5-only rows. */
export function alarmMetricLabels(row: DiagnosisSignal, k: number): string[] {
  const origins = row.origins ?? [];
  const reason = (row.reason ?? "").toLowerCase();
  const hasZ =
    origins.includes("zscore") ||
    reason.includes("z-score") ||
    reason.includes("zscore");
  const hasV5 =
    origins.some((o) => o !== "zscore") ||
    reason.includes("v5") ||
    reason.includes("moment") ||
    reason.includes("freeze") ||
    reason.includes("amp");

  if (hasZ && !hasV5) {
    return [`|z| ${fmt(row.z)}`, `score ${fmt(row.score)}/${k}`];
  }
  if (!hasZ && hasV5) {
    if (reason.includes("freeze") || origins.includes("freeze")) {
      return [`freeze +${fmt(row.score)}`];
    }
    if (reason.includes("amp") || origins.includes("amp")) {
      return [`amp q90 ${fmt(row.score)}`];
    }
    return [`moment z ${fmt(row.z)}`];
  }
  if (hasZ && hasV5) {
    return [`|z| ${fmt(row.z)}`, `score ${fmt(row.score)}/${k}`];
  }
  return [`|z| ${fmt(row.z)}`, `score ${fmt(row.score)}/${k}`];
}

export type SystemReport = {
  text: string;
  generatedAt: string;
  model: string;
  hash: string;
  bytes: number;
};

export type DataFlowRecord = {
  model: string;
  host: string;
  noEgress: boolean;
  leaves: string;
  why: string;
  swap: string;
};

export type SensorNote = {
  understanding?: {
    field_id: string;
    guess: string;
    confidence: number;
    observations: string;
    role?: string;
  };
  quality?: {
    field_id: string;
    faulty: boolean;
    issue: string;
    adjective: string;
    confidence: number;
    summary: string;
  };
};

export type SystemAgentStatus = {
  running: boolean;
  loop: "manual" | "continuous";
  step: "idle" | "understanding" | "quality" | "diagnosis" | "error";
  startedAt: string | null;
  lastCycleAt: string | null;
  lastBeatAt: string | null;
  error: string | null;
  eventId: string | null;
  understanding: SystemReport | null;
  quality: SystemReport | null;
  diagnosis: SystemReport | null;
  critique: SystemReport | null;
  alarmDiagnoses: Record<string, SystemReport>;
  rootCauseSignalId: string | null;
  sensors: Record<string, SensorNote>;
  dataFlow: DataFlowRecord;
};

export const IDLE_AGENT: SystemAgentStatus = {
  running: false,
  loop: "manual",
  step: "idle",
  startedAt: null,
  lastCycleAt: null,
  lastBeatAt: null,
  error: null,
  eventId: null,
  understanding: null,
  quality: null,
  diagnosis: null,
  critique: null,
  alarmDiagnoses: {},
  rootCauseSignalId: null,
  sensors: {},
  dataFlow: {
    model: "—",
    host: "—",
    noEgress: false,
    leaves: "",
    why: "",
    swap: "",
  },
};

export function stepLabel(
  step: SystemAgentStatus["step"],
  rootCauseSignalId?: string | null,
) {
  if (step === "understanding") return "Understanding…";
  if (step === "quality") return "Quality…";
  if (step === "diagnosis") {
    return rootCauseSignalId
      ? `Root cause for ${rootCauseSignalId}…`
      : "Root cause…";
  }
  if (step === "error") return "Cycle failed";
  return "Idle";
}

export function NavButton<Id extends string>({
  item,
  active,
  onClick,
  warn,
}: {
  item: { id: Id; label: string; icon: typeof Activity; hint?: string };
  active: boolean;
  onClick: () => void;
  warn?: boolean;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint ? (
        <span className="font-mono text-[10px] text-muted-foreground">
          {item.hint}
        </span>
      ) : warn ? (
        <span className="font-mono text-[10px] text-red-300">no</span>
      ) : null}
    </button>
  );
}

export function ReportPane({
  title,
  blurb,
  report,
  running,
  badge,
  badgeTone,
  hideTitle = false,
}: {
  title: string;
  blurb: string;
  report: SystemReport | null;
  running: boolean;
  badge?: string | null;
  badgeTone?: "ok" | "bad";
  hideTitle?: boolean;
}) {
  return (
    <div className="space-y-3">
      {!hideTitle && (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
          </div>
          {badge && (
            <Badge variant={badgeTone === "bad" ? "destructive" : "secondary"}>
              {badge}
            </Badge>
          )}
        </div>
      )}
      {hideTitle && badge && (
        <div className="flex justify-end">
          <Badge variant={badgeTone === "bad" ? "destructive" : "secondary"}>
            {badge}
          </Badge>
        </div>
      )}
      {running && (
        <p className="font-mono text-xs text-muted-foreground">
          Writing this report…
        </p>
      )}
      {report ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="mb-3 font-mono text-[10px] text-muted-foreground">
            {report.model} · {new Date(report.generatedAt).toLocaleString()} ·
            hash {report.hash} · {report.bytes} B in
          </p>
          <ChatMarkdown text={report.text} />
        </div>
      ) : (
        !running && (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Launch the system agent on System Dashboard for one
            cycle.
          </p>
        )
      )}
    </div>
  );
}

function sourceLabel(fieldId: string) {
  const sep = fieldId.indexOf("::");
  return sep >= 0 ? fieldId.slice(0, sep) : "";
}

function alarmTelemetryHref(row: DiagnosisSignal) {
  const top = row.top_fields[0];
  return top ? telemetryHref(top.field_id) : "/telemetry";
}

const ALARM_ROW_GRID =
  "grid grid-cols-[2rem_3rem_3rem_3.25rem_minmax(4.5rem,1fr)_minmax(3.5rem,1fr)_auto] items-center gap-x-2";

const ALARM_ACTION_LEGEND = [
  { icon: Brain, label: "Run root-cause analysis" },
  { icon: Eye, label: "Show or hide analysis" },
  { icon: ChevronRight, label: "Expand channel stats" },
  { icon: Activity, label: "View in Telemetry" },
] as const;

function AlarmIconButton({
  label,
  onClick,
  disabled,
  children,
  active,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant={active ? "secondary" : "ghost"}
      className="size-6 shrink-0"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function DriftPane({
  current,
  signals,
  open,
  setOpen,
  onRootCause,
  alarmDiagnoses = {},
  rootCauseSignalId = null,
  hideHeader = false,
}: {
  current: DiagnosisSnapshot["current"] | null;
  signals: DiagnosisSignal[];
  open: string | null;
  setOpen: (id: string | null) => void;
  onRootCause?: (id: string) => void;
  alarmDiagnoses?: Record<string, SystemReport>;
  rootCauseSignalId?: string | null;
  hideHeader?: boolean;
}) {
  const k = current?.k ?? 6;
  const zYellow = current?.z_yellow ?? 4;
  const zRed = current?.z_red ?? 6;
  const orderedSignals = useMemo(() => alarmsOldestFirst(signals), [signals]);
  const [rootCauseExpanded, setRootCauseExpanded] = useState<
    Record<string, boolean>
  >({});

  return (
    <div className="space-y-3">
      {!hideHeader && (
        <div>
          <h2 className="text-sm font-medium">Alarms</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Two detectors share this log. Rolling z-score: yellow after {k}{" "}
            consecutive samples past {fmt(zYellow)}σ, red past {fmt(zRed)}σ —
            brief spikes do not open one. v5 agnostic: expanding-moment RMS,
            freeze streaks, and amplitude envelope (gates ease after burn-in).
            Plant level is the max of both — either can open an alarm. Score/k
            is the z-score streak when that model fires; v5-only rows show
            moment/freeze/amp instead.
          </p>
        </div>
      )}
      <p className="font-mono text-xs text-muted-foreground">
        {current
          ? `live · tick ${current.tick} · max|z|=${fmt(current.z)} · score ${fmt(current.score)}/${k} · ${
              current.calibrated
                ? "calibrated"
                : `warming up (first ${current.burn_in ?? 20} samples)`
            }`
          : "Waiting for the stream."}
      </p>

      {signals.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          No alarms yet. Play the stream — a single spike never opens one.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <div className="min-w-[36rem]">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground">
              {ALARM_ACTION_LEGEND.map(({ icon: Icon, label }) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <span className="inline-flex size-6 items-center justify-center rounded-md border border-border/60 bg-background">
                    <Icon className="size-3" aria-hidden="true" />
                  </span>
                  {label}
                </span>
              ))}
            </div>
            <div
              className={cn(
                ALARM_ROW_GRID,
                "border-b border-border bg-muted/40 px-2 py-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase",
              )}
            >
              <span>Lvl</span>
              <span className="text-right tabular-nums">Tick</span>
              <span className="text-right tabular-nums">|z|</span>
              <span className="text-right tabular-nums">Score</span>
              <span>Field</span>
              <span>Source</span>
              <span aria-hidden="true" />
            </div>
            <ul>
              {orderedSignals.map((row) => {
                const top = row.top_fields[0];
                const source = top ? sourceLabel(top.field_id) : "—";
                const field = top ? fieldLabel(top.field_id) : "—";
                const href = alarmTelemetryHref(row);
                const expanded = open === row.id;
                const diagnosis = alarmDiagnoses[row.id] ?? null;
                const rootCauseBusy = rootCauseSignalId === row.id;
                const hasRootCause = Boolean(diagnosis);
                const showRootCause =
                  hasRootCause && Boolean(rootCauseExpanded[row.id]);
                return (
                  <li
                    key={row.id}
                    className="border-b border-border last:border-b-0"
                  >
                    <div
                      className={cn(
                        ALARM_ROW_GRID,
                        "px-2 py-1 font-mono text-[11px]",
                      )}
                    >
                      <span
                        className={cn(
                          "font-semibold tabular-nums",
                          row.level === "red"
                            ? "text-red-300"
                            : "text-amber-300",
                        )}
                        title={row.level}
                      >
                        {row.level === "red" ? "R" : "Y"}
                      </span>
                      <span className="text-right tabular-nums text-foreground">
                        {row.tick}
                      </span>
                      <span className="text-right tabular-nums text-foreground">
                        {fmt(row.z)}
                      </span>
                      <span className="text-right tabular-nums text-muted-foreground">
                        {fmt(row.score)}/{k}
                      </span>
                      <span className="truncate text-foreground" title={field}>
                        {field}
                      </span>
                      <span
                        className="truncate text-muted-foreground"
                        title={source}
                      >
                        {source}
                      </span>
                      <div className="flex items-center justify-end gap-0.5">
                        {onRootCause && (
                          <AlarmIconButton
                            label={
                              rootCauseBusy
                                ? "Analyzing root cause"
                                : "Do root cause analysis"
                            }
                            disabled={
                              Boolean(rootCauseSignalId) || hasRootCause
                            }
                            onClick={() => onRootCause(row.id)}
                          >
                            {rootCauseBusy ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Brain className="size-3" />
                            )}
                          </AlarmIconButton>
                        )}
                        <AlarmIconButton
                          label={
                            showRootCause
                              ? "Hide root cause analysis"
                              : "Show root cause analysis"
                          }
                          active={showRootCause}
                          disabled={!hasRootCause}
                          onClick={() =>
                            setRootCauseExpanded((state) => ({
                              ...state,
                              [row.id]: !showRootCause,
                            }))
                          }
                        >
                          {showRootCause ? (
                            <EyeOff className="size-3" />
                          ) : (
                            <Eye className="size-3" />
                          )}
                        </AlarmIconButton>
                        <AlarmIconButton
                          label={
                            expanded
                              ? "Hide channel details"
                              : "Show channel details"
                          }
                          active={expanded}
                          onClick={() => setOpen(expanded ? null : row.id)}
                        >
                          {expanded ? (
                            <ChevronDown className="size-3" />
                          ) : (
                            <ChevronRight className="size-3" />
                          )}
                        </AlarmIconButton>
                        <Link
                          href={href}
                          className={buttonVariants({
                            variant: "ghost",
                            size: "icon-xs",
                          })}
                          title="View in Telemetry"
                          aria-label="View in Telemetry"
                        >
                          <Activity className="size-3" />
                        </Link>
                      </div>
                    </div>
                    {showRootCause && diagnosis && !rootCauseBusy && (
                      <div className="border-t border-border/60 bg-muted/10 px-2 py-2">
                        <p className="mb-1 font-mono text-[10px] text-muted-foreground">
                          Root cause · {diagnosis.model} ·{" "}
                          {new Date(diagnosis.generatedAt).toLocaleString()}
                        </p>
                        <div className="text-xs">
                          <ChatMarkdown text={diagnosis.text} />
                        </div>
                      </div>
                    )}
                    {expanded && (
                      <div className="border-t border-border/60 bg-muted/5 px-2 py-1.5">
                        <p className="mb-1 truncate font-mono text-[10px] text-muted-foreground">
                          {row.evidence ||
                            "Alarm opened from pooled channel z-scores."}
                        </p>
                        {row.top_fields.length > 0 && (
                          <div className="overflow-x-auto">
                            <div className="grid min-w-[28rem] grid-cols-[minmax(5rem,1.2fr)_3rem_3.5rem_3.5rem_3rem_3rem] gap-x-2 border-b border-border/50 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                              <span>Channel</span>
                              <span className="text-right">|z|</span>
                              <span className="text-right">Mean</span>
                              <span className="text-right">SD</span>
                              <span className="text-right">Skew</span>
                              <span className="text-right">Kurt</span>
                            </div>
                            {row.top_fields.map((item) => (
                              <div
                                key={item.field_id}
                                className="grid min-w-[28rem] grid-cols-[minmax(5rem,1.2fr)_3rem_3.5rem_3.5rem_3rem_3rem] gap-x-2 py-0.5 font-mono text-[10px]"
                              >
                                <Link
                                  href={telemetryHref(item.field_id)}
                                  className="truncate underline-offset-2 hover:underline"
                                  title={item.field_id}
                                >
                                  {fieldLabel(item.field_id)}
                                </Link>
                                <span className="text-right tabular-nums">
                                  {fmt(item.score)}
                                </span>
                                <span className="text-right tabular-nums text-muted-foreground">
                                  {fmt(item.mean)}
                                </span>
                                <span className="text-right tabular-nums text-muted-foreground">
                                  {fmt(item.sd)}
                                </span>
                                <span className="text-right tabular-nums text-muted-foreground">
                                  {fmt(item.skew)}
                                </span>
                                <span className="text-right tabular-nums text-muted-foreground">
                                  {fmt(item.kurt)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export function FlowPane({ flow }: { flow: DataFlowRecord }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h2 className="text-sm font-medium">Data flow</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What leaves this environment, to which model, and why. The LLM layer
          is swapped by config, not a rewrite.
        </p>
      </div>
      <dl className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Model</dt>
          <dd className="font-mono text-xs">
            {flow.model} @ {flow.host}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">No-egress</dt>
          <dd className="font-mono text-xs">
            {flow.noEgress ? "on — local host required" : "off"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">What leaves</dt>
          <dd>{flow.leaves || "Launch or refresh to read the live record."}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Why</dt>
          <dd>{flow.why}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Swap the model</dt>
          <dd>{flow.swap}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Adaptability</dt>
          <dd>
            Sources are unlabeled columns with a kind of process, business, or
            other. The z-score detector and these reports never require TEP
            names. A second CSV under Telemetry is the same pipeline.
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function ReviewPane({
  eventId,
  lastCycleAt,
  note,
  onNote,
  busy,
  msg,
  onReview,
  hideHeader = false,
}: {
  eventId: string | null;
  lastCycleAt: string | null;
  note: string;
  onNote: (value: string) => void;
  busy: boolean;
  msg: string | null;
  onReview: (action: "accept" | "question" | "override") => void;
  hideHeader?: boolean;
}) {
  return (
    <div className="space-y-4">
      {!hideHeader && (
        <div>
          <h2 className="text-sm font-medium">Judgment</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Accept, question, or override the latest system conclusion.
            Everything on this dashboard is in front of you. Questions open the
            operator chat. Every action is written to the decision log.
          </p>
        </div>
      )}
      <p className="font-mono text-xs text-muted-foreground">
        target {eventId ?? "system:diagnosis"}
        {lastCycleAt
          ? ` · last cycle ${new Date(lastCycleAt).toLocaleTimeString()}`
          : " · no cycle yet"}
      </p>
      <Textarea
        value={note}
        onChange={(event) => onNote(event.target.value)}
        placeholder="Optional note for the log"
        rows={4}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => onReview("accept")}>
          <Check />
          Accept
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onReview("question")}
        >
          <HelpCircle />
          Question
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => onReview("override")}
        >
          <ShieldAlert />
          Override
        </Button>
      </div>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
