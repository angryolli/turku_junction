"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  browserGet,
  browserPost,
  monitorStreamUrl,
  type MonitorSnapshot,
  type RuntimeConfig,
  type StreamResetResponse,
} from "@/lib/browser-api";

const DEFAULT_TPS = 2.22;
export const MIN_TICKS_PER_SECOND = 0.5;
export const MAX_TICKS_PER_SECOND = 50;

type SimulationContextValue = {
  playing: boolean;
  finished: boolean;
  resetting: boolean;
  resetRevision: number;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => Promise<void>;
  resetSimulation: () => Promise<StreamResetResponse>;
  ticksPerSecond: number;
  setTicksPerSecond: (rate: number) => Promise<void>;
  applySnapshot: (snap: {
    playing?: boolean | null;
    ticks_per_second?: number | null;
    finished?: boolean | null;
  }) => void;
};

const SimulationContext = createContext<SimulationContextValue>({
  playing: false,
  finished: false,
  resetting: false,
  resetRevision: 0,
  setPlaying: () => undefined,
  togglePlay: async () => ({ snapshot: {} as MonitorSnapshot, archived_run_id: null }),
  resetSimulation: async () => ({ snapshot: {} as MonitorSnapshot, archived_run_id: null }),
  ticksPerSecond: DEFAULT_TPS,
  setTicksPerSecond: async () => undefined,
  applySnapshot: () => undefined,
});

function clampRate(rate: number) {
  if (!Number.isFinite(rate)) return DEFAULT_TPS;
  return Math.min(MAX_TICKS_PER_SECOND, Math.max(MIN_TICKS_PER_SECOND, rate));
}

export function SimulationProvider({ children }: { children: React.ReactNode }) {
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetRevision, setResetRevision] = useState(0);
  const [ticksPerSecond, setTicksPerSecondState] = useState(DEFAULT_TPS);

  useEffect(() => {
    void browserGet<RuntimeConfig>("/config")
      .then((data) => {
        setPlaying(Boolean(data.playing));
        setFinished(Boolean(data.finished));
        if (data.ticks_per_second != null) {
          setTicksPerSecondState(clampRate(data.ticks_per_second));
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;

    function apply(data: MonitorSnapshot) {
      if (!on) return;
      if (data.playing != null) setPlaying(Boolean(data.playing));
      if (data.finished != null) setFinished(Boolean(data.finished));
      if (data.ticks_per_second != null) {
        setTicksPerSecondState(clampRate(data.ticks_per_second));
      }
    }

    function connect() {
      source?.close();
      source = new EventSource(monitorStreamUrl());
      source.addEventListener("snapshot", (event) => {
        try {
          apply(JSON.parse((event as MessageEvent<string>).data) as MonitorSnapshot);
        } catch {
          /* ignore malformed frames */
        }
      });
      source.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data) as MonitorSnapshot);
        } catch {
          /* ignore malformed frames */
        }
      };
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

  const applySnapshot = useCallback(
    (snap: {
      playing?: boolean | null;
      ticks_per_second?: number | null;
      finished?: boolean | null;
    }) => {
      if (snap.playing != null) setPlaying(Boolean(snap.playing));
      if (snap.finished != null) setFinished(Boolean(snap.finished));
      if (snap.ticks_per_second != null) {
        setTicksPerSecondState(clampRate(snap.ticks_per_second));
      }
    },
    [],
  );

  const togglePlay = useCallback(async () => {
    const snap = await browserPost<MonitorSnapshot>("/stream/control", {
      playing: !playing,
    });
    setPlaying(Boolean(snap.playing));
    setFinished(Boolean(snap.finished));
    if (snap.ticks_per_second != null) {
      setTicksPerSecondState(clampRate(snap.ticks_per_second));
    }
  }, [playing]);

  const setTicksPerSecond = useCallback(async (rate: number) => {
    const next = clampRate(rate);
    setTicksPerSecondState(next);
    const snap = await browserPost<MonitorSnapshot>("/stream/control", {
      ticks_per_second: next,
    });
    if (snap.ticks_per_second != null) {
      setTicksPerSecondState(clampRate(snap.ticks_per_second));
    }
    if (snap.playing != null) setPlaying(Boolean(snap.playing));
    if (snap.finished != null) setFinished(Boolean(snap.finished));
  }, []);

  const resetSimulation = useCallback(async () => {
    setResetting(true);
    try {
      const body = await browserPost<StreamResetResponse>("/stream/reset", {});
      applySnapshot(body.snapshot);
      await fetch("/api/system-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      }).catch(() => undefined);
      setResetRevision((value) => value + 1);
      return body;
    } finally {
      setResetting(false);
    }
  }, [applySnapshot]);

  const value = useMemo<SimulationContextValue>(
    () => ({
      playing,
      finished,
      resetting,
      resetRevision,
      setPlaying,
      togglePlay,
      resetSimulation,
      ticksPerSecond,
      setTicksPerSecond,
      applySnapshot,
    }),
    [
      playing,
      finished,
      resetting,
      resetRevision,
      togglePlay,
      resetSimulation,
      ticksPerSecond,
      setTicksPerSecond,
      applySnapshot,
    ],
  );

  return (
    <SimulationContext.Provider value={value}>{children}</SimulationContext.Provider>
  );
}

export function useSimulation() {
  return useContext(SimulationContext);
}
