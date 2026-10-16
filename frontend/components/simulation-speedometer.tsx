"use client";

import {
  MAX_TICKS_PER_SECOND,
  MIN_TICKS_PER_SECOND,
  useSimulation,
} from "@/components/simulation-context";
import { cn } from "@/lib/utils";

const PRESETS = [1, 2, 5, 10, 20, 50] as const;

function nextPreset(current: number) {
  const idx = PRESETS.findIndex((v) => v > current + 0.01);
  return PRESETS[idx >= 0 ? idx : 0];
}

/** Semicircle speedometer + slider for simulation rate (ticks per second). */
export function SimulationSpeedometer({ compact = false }: { compact?: boolean }) {
  const { ticksPerSecond, setTicksPerSecond, playing } = useSimulation();
  const min = MIN_TICKS_PER_SECOND;
  const max = MAX_TICKS_PER_SECOND;
  const ratio = (ticksPerSecond - min) / (max - min);
  // Needle sweeps −90° (left) to +90° (right) across the arc.
  const angle = -90 + ratio * 180;
  const label =
    ticksPerSecond >= 10 ? ticksPerSecond.toFixed(0) : ticksPerSecond.toFixed(1);

  return (
    <div className={cn("select-none", compact ? "px-0.5" : "px-1")}>
      <button
        type="button"
        className={cn(
          "relative mx-auto block w-full rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring",
          compact ? "max-w-none" : "max-w-[11rem]",
        )}
        title={
          compact
            ? `${label} ticks/s — click to step rate`
            : `${label} ticks per second`
        }
        aria-label={
          compact
            ? `Simulation rate ${label} ticks per second. Click to step to the next preset.`
            : `Simulation rate ${label} ticks per second`
        }
        onClick={() => {
          if (!compact) return;
          void setTicksPerSecond(nextPreset(ticksPerSecond)).catch(() => undefined);
        }}
      >
        <svg
          viewBox="0 0 120 88"
          className="h-auto w-full text-muted-foreground"
          aria-hidden
        >
          <path
            d="M 12 52 A 48 48 0 0 1 108 52"
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            opacity={0.25}
          />
          <path
            d="M 12 52 A 48 48 0 0 1 108 52"
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${Math.max(2, ratio * 100)} 100`}
            className={playing ? "text-foreground" : "text-muted-foreground"}
          />
          <g transform={`rotate(${angle} 60 52)`}>
            <line
              x1="60"
              y1="52"
              x2="60"
              y2="14"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="text-foreground"
            />
            <circle cx="60" cy="52" r="3.5" className="fill-foreground" />
          </g>
          <text
            x="60"
            y="68"
            textAnchor="middle"
            className="fill-foreground"
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: compact ? 11 : 14,
              fontWeight: 500,
            }}
          >
            {label}
          </text>
          {!compact && (
            <text
              x="60"
              y="80"
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 9,
              }}
            >
              ticks/s
            </text>
          )}
        </svg>
      </button>

      {!compact && (
        <label className="mt-1 block space-y-1">
          <span className="sr-only">Simulation rate in ticks per second</span>
          <input
            type="range"
            min={min}
            max={max}
            step={0.5}
            value={ticksPerSecond}
            onChange={(e) => {
              const next = Number(e.target.value);
              void setTicksPerSecond(next).catch(() => undefined);
            }}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-foreground"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={ticksPerSecond}
            aria-valuetext={`${label} ticks per second`}
          />
          <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>{min}</span>
            <span>{max}</span>
          </div>
        </label>
      )}
    </div>
  );
}
