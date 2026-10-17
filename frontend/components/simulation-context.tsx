"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  asOf: string | null;
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
  asOf: null,
  finished: false,
  resetting: false,
  resetRevision: 0,
  setPlaying: () => undefined,
  togglePlay: async () => undefined,
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
  const [asOf, setAsOf] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const seenRevision = useRef(0);
  const playBusy = useRef(false);
  const [resetting, setResetting] = useState(false);
  const [resetRevision, setResetRevision] = useState(0);
  const [ticksPerSecond, setTicksPerSecondState] = useState(DEFAULT_TPS);

  useEffect(() => {
    void browserGet<RuntimeConfig>("/config")
      .then((data) => {
        if (seenRevision.current !== 0) return;
        setPlaying(Boolean(data.playing));
        setFinished(Boolean(data.finished));
        if (data.as_of !== undefined) setAsOf(data.as_of ?? null);
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
      if (data.revision != null && data.revision < seenRevision.current) return;
      if (data.revision != null) seenRevision.current = data.revision;
      if (data.playing != null) setPlaying(Boolean(data.playing));
      if (data.finished != null) setFinished(Boolean(data.finished));
      if (data.as_of !== undefined) setAsOf(data.as_of);
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
      revision?: number | null;
      playing?: boolean | null;
      ticks_per_second?: number | null;
      finished?: boolean | null;
      as_of?: string | null;
    }) => {
      if (snap.revision != null && snap.revision < seenRevision.current) return;
      if (snap.revision != null) seenRevision.current = snap.revision;
      if (snap.playing != null) setPlaying(Boolean(snap.playing));
      if (snap.finished != null) setFinished(Boolean(snap.finished));
      if (snap.as_of !== undefined) setAsOf(snap.as_of ?? null);
      if (snap.ticks_per_second != null) {
        setTicksPerSecondState(clampRate(snap.ticks_per_second));
      }
    },
    [],
  );

  const resetSimulation = useCallback(async () => {
    setResetting(true);
    try {
      const body = await browserPost<StreamResetResponse>("/stream/reset", {});
      applySnapshot(body.snapshot);
      setResetRevision((value) => value + 1);
      return body;
    } finally {
      setResetting(false);
    }
  }, [applySnapshot]);

  const togglePlay = useCallback(async () => {
    if (playBusy.current) return;
    playBusy.current = true;
    try {
      if (!playing && finished) {
        await resetSimulation();
      }
      const snap = await browserPost<MonitorSnapshot>("/stream/control", {
        playing: !playing,
      });
      applySnapshot(snap);
    } finally {
      playBusy.current = false;
    }
  }, [applySnapshot, finished, playing, resetSimulation]);

  const setTicksPerSecond = useCallback(async (rate: number) => {
    const next = clampRate(rate);
    setTicksPerSecondState(next);
    const snap = await browserPost<MonitorSnapshot>("/stream/control", {
      ticks_per_second: next,
    });
    applySnapshot(snap);
  }, [applySnapshot]);

  const value = useMemo<SimulationContextValue>(
    () => ({
      playing,
      asOf,
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
      asOf,
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
