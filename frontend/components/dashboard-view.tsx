"use client";

import { Bot, Pause } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DashboardSection } from "@/components/dashboard-section";
import { DashboardSourcesMap } from "@/components/dashboard-sources-map";
import { SensorIntelGrid } from "@/components/sensor-intel-card";
import {
  DriftPane,
  fmt,
  IDLE_AGENT,
  stepLabel,
  type SystemAgentStatus,
} from "@/components/monitor-panes";
import { eventsStreamUrl, monitorStreamUrl, type MonitorSnapshot } from "@/lib/browser-api";
import type { DiagnosisSignal, DiagnosisSnapshot } from "@/lib/pipeline";
import { useSimulation } from "@/components/simulation-context";

function mergeAgent(data: SystemAgentStatus): SystemAgentStatus {
  return {
    ...IDLE_AGENT,
    ...data,
    sensors: data.sensors ?? {},
    alarmDiagnoses: data.alarmDiagnoses ?? {},
  };
}

export function DashboardView() {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [signals, setSignals] = useState<DiagnosisSignal[]>([]);
  const [current, setCurrent] = useState<DiagnosisSnapshot["current"] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [systemAgent, setSystemAgent] = useState<SystemAgentStatus>(IDLE_AGENT);
  const [systemAgentBusy, setSystemAgentBusy] = useState(false);
  const { playing, finished, resetRevision } = useSimulation();
  const monitorKey = useRef("");

  useEffect(() => {
    setSnap(null);
    setSignals([]);
    setCurrent(null);
    setOpen(null);
    setSystemAgent(IDLE_AGENT);
    monitorKey.current = "";
  }, [resetRevision]);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;

    function apply(data: MonitorSnapshot) {
      if (!on) return;
      const key = [
        data.tick,
        data.playing,
        data.finished,
        (data.fields ?? []).map((f) => `${f.source_id}:${f.field_id}:${f.sparkline.length}`).join("|"),
      ].join("#");
      if (key === monitorKey.current) return;
      monitorKey.current = key;
      setSnap(data);
    }

    function connect() {
      source?.close();
      source = new EventSource(monitorStreamUrl());
      source.addEventListener("snapshot", (event) => {
        try {
          apply(JSON.parse((event as MessageEvent<string>).data) as MonitorSnapshot);
        } catch {
          /* ignore */
        }
      });
    }

    function onVis() {
      if (document.hidden) {
        source?.close();
        source = null;
        return;
      }
      connect();
    }

    connect();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      on = false;
      document.removeEventListener("visibilitychange", onVis);
      source?.close();
    };
  }, []);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;
    const sig = { current: "" };

    function apply(data: DiagnosisSnapshot) {
      if (!on) return;
      const next = data.signals ?? data.events ?? [];
      const nextSig = [
        next.map((row) => `${row.id}:${row.level}:${row.tick}:${row.z}`).join("|"),
        data.current?.tick,
        data.current?.z,
      ].join("#");
      if (nextSig === sig.current) return;
      sig.current = nextSig;
      setSignals(next);
      setCurrent(data.current ?? null);
    }

    function connect() {
      source?.close();
      source = new EventSource(eventsStreamUrl());
      source.addEventListener("events", (event) => {
        try {
          apply(JSON.parse((event as MessageEvent<string>).data) as DiagnosisSnapshot);
        } catch {
          /* ignore */
        }
      });
    }

    function onVis() {
      if (document.hidden) {
        source?.close();
        source = null;
        return;
      }
      connect();
    }

    connect();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      on = false;
      document.removeEventListener("visibilitychange", onVis);
      source?.close();
    };
  }, []);

  useEffect(() => {
    let on = true;
    async function pull() {
      try {
        const res = await fetch("/api/system-agent");
        const data = (await res.json()) as SystemAgentStatus;
        if (on) setSystemAgent(mergeAgent(data));
      } catch {
        /* ignore */
      }
    }
    void pull();
    return () => {
      on = false;
    };
  }, [resetRevision]);

  useEffect(() => {
    if (!systemAgent.running && !systemAgent.rootCauseSignalId) return;
    let on = true;
    const id = window.setInterval(() => {
      fetch("/api/system-agent")
        .then((r) => r.json())
        .then((data: SystemAgentStatus) => {
          if (on) setSystemAgent(mergeAgent(data));
        })
        .catch(() => undefined);
    }, 800);
    return () => {
      on = false;
      window.clearInterval(id);
    };
  }, [systemAgent.running, systemAgent.rootCauseSignalId]);

  async function toggleSystemAgent() {
    setSystemAgentBusy(true);
    try {
      const res = await fetch("/api/system-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ running: !systemAgent.running }),
      });
      const data = (await res.json()) as SystemAgentStatus;
      setSystemAgent(mergeAgent(data));
    } catch {
      /* ignore */
    } finally {
      setSystemAgentBusy(false);
    }
  }

  async function requestRootCause(signalId: string) {
    setOpen(signalId);
    setSystemAgent((prev) => ({
      ...prev,
      step: "diagnosis",
      rootCauseSignalId: signalId,
      error: null,
    }));
    try {
      const res = await fetch("/api/system-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootCauseSignalId: signalId }),
      });
      const data = (await res.json()) as SystemAgentStatus & { error?: string };
      if (!res.ok) {
        setSystemAgent((prev) => ({
          ...prev,
          step: "error",
          rootCauseSignalId: null,
          error: data.error ?? "Root-cause analysis failed",
        }));
        return;
      }
      setSystemAgent(mergeAgent(data));
    } catch {
      setSystemAgent((prev) => ({
        ...prev,
        step: "error",
        rootCauseSignalId: null,
        error: "Root-cause analysis failed",
      }));
    }
  }

  const fields = snap?.fields ?? [];
  const tick = snap?.tick ?? current?.tick ?? 0;
  const agentStatusLabel =
    systemAgent.running || systemAgent.rootCauseSignalId
      ? stepLabel(systemAgent.step, systemAgent.rootCauseSignalId)
      : systemAgent.error
        ? systemAgent.error
        : "Manual cycle · understanding and quality";

  return (
    <div className="flex h-full min-h-0">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-10 pb-8">
          <DashboardSourcesMap
            fields={fields}
            playing={playing}
            finished={finished}
            tick={tick}
            signals={signals}
          />

          <DashboardSection
            title="Sensor understanding"
            subtitle="Best guess of what each channel measures, how confident that guess is, and a quick read on the live stream."
          >
            <SensorIntelGrid fields={fields} sensors={systemAgent.sensors} mode="understanding" />
          </DashboardSection>

          <DashboardSection
            title="Quality"
            subtitle="Instrument health for the current run."
            emphasis
            divider
          >
            <DashboardSection title="Data quality checks" variant="secondary" emphasis>
              <SensorIntelGrid fields={fields} sensors={systemAgent.sensors} mode="quality" />
            </DashboardSection>
          </DashboardSection>

          <DashboardSection
            title="Alarms"
            subtitle="Drift flags from the live stream. Run root-cause analysis per alarm when needed."
            emphasis
            divider
          >
            <DashboardSection
              title="Drift & anomaly detection"
              subtitle="Continuous monitoring output. Use Do root cause analysis on an alarm card to investigate it."
              variant="secondary"
              emphasis
            >
              <DriftPane
                current={current}
                signals={signals}
                open={open}
                setOpen={setOpen}
                onRootCause={(id) => void requestRootCause(id)}
                alarmDiagnoses={systemAgent.alarmDiagnoses}
                rootCauseSignalId={systemAgent.rootCauseSignalId}
                hideHeader
              />
            </DashboardSection>
          </DashboardSection>
        </div>
      </div>

      <aside className="flex w-60 shrink-0 flex-col border-l border-border bg-background">
        <div className="border-b border-border px-3 py-3">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">System Dashboard</p>
        </div>
        <div className="border-b border-border px-2 py-2">
          <Button
            size="sm"
            variant={systemAgent.running ? "secondary" : "default"}
            className="h-auto w-full justify-start gap-2 py-2 whitespace-normal"
            onClick={() => void toggleSystemAgent()}
            disabled={systemAgentBusy || Boolean(systemAgent.rootCauseSignalId)}
            aria-label={systemAgent.running ? "Stop system agent" : "Launch system agent"}
          >
            {systemAgent.running ? (
              <Pause className="size-4 shrink-0" />
            ) : (
              <Bot className="size-4 shrink-0" />
            )}
            <span className="text-left leading-tight">
              {systemAgent.running ? "Stop system agent" : "Launch system agent"}
            </span>
          </Button>
          <p className="mt-1.5 px-1 font-mono text-[10px] text-muted-foreground">{agentStatusLabel}</p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-[11px] text-muted-foreground">
          <p>
            {signals.filter((row) => row.level === "yellow").length} yellow ·{" "}
            {signals.filter((row) => row.level === "red").length} red
          </p>
          <p>
            {fields.length} source{fields.length === 1 ? "" : "s"} · tick {tick}
          </p>
          <p>
            {systemAgent.lastCycleAt
              ? `last cycle ${new Date(systemAgent.lastCycleAt).toLocaleTimeString()}`
              : "no agent cycle yet"}
          </p>
          <Link href="/reports" className="underline-offset-2 hover:underline">
            Field reports in Reports & Logs
          </Link>
          <Link href="/telemetry" className="underline-offset-2 hover:underline">
            Inspect streams on Telemetry
          </Link>
        </div>
        <div className="border-t border-border px-3 py-3 font-mono text-[10px] text-muted-foreground">
          {current
            ? `max|z|=${fmt(current.z)} · ${
                current.calibrated ? "calibrated" : "warming up"
              }`
            : "Waiting for stream"}
        </div>
      </aside>
    </div>
  );
}
