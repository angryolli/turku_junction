"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StreamChart, type ChartMark } from "@/components/stream-chart";
import { cn } from "@/lib/utils";
import type { FieldCard } from "@/lib/browser-api";
import type { SensorNote } from "@/components/monitor-panes";
import { noteForField, SensorIntelCard } from "@/components/sensor-intel-card";

type Origin = { left: number; top: number; width: number; height: number };

export function noteForStream(
  sensors: Record<string, SensorNote> | undefined,
  stream: FieldCard,
): SensorNote | null {
  return noteForField(sensors, stream.source_id ?? "", stream.field_id);
}

export function SourceModal({
  stream,
  origin,
  tick,
  marks,
  note,
  onClose,
}: {
  stream: FieldCard;
  origin: Origin;
  tick?: number;
  marks?: ChartMark[];
  note: SensorNote | null;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const desktop = vw >= 768;
  const targetW = Math.min(desktop ? origin.width * 2 : vw - 32, vw - 32);
  const targetLeft = Math.max(16, (vw - targetW) / 2);
  const targetTop = Math.max(16, vh * 0.08);

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function close() {
    if (closing) return;
    setClosing(true);
    setExpanded(false);
    window.setTimeout(onClose, 280);
  }

  const open = expanded && !closing;
  const box = open
    ? { left: targetLeft, top: targetTop, width: targetW }
    : { left: origin.left, top: origin.top, width: origin.width };

  return (
    <div className="fixed inset-0 z-[210]">
      <button
        type="button"
        aria-label="Close source"
        className={cn(
          "absolute inset-0 bg-black/40 transition-all duration-300",
          open ? "opacity-100 backdrop-blur-md" : "opacity-0 backdrop-blur-none",
        )}
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-modal-title"
        className={cn(
          "absolute overflow-hidden rounded-xl border border-border bg-card shadow-lg transition-[left,top,width,max-height] duration-300 ease-out",
          open ? "overflow-y-auto" : "overflow-hidden",
        )}
        style={{
          left: box.left,
          top: box.top,
          width: box.width,
          maxHeight: open ? vh - 32 : origin.height,
        }}
      >
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="source-modal-title" className="truncate font-mono text-sm">
                {stream.field_id}
              </h2>
              <p className="truncate text-[11px] text-muted-foreground">
                {stream.source_file || "—"}
              </p>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={close} aria-label="Close">
              <X />
            </Button>
          </div>
          <div className="mt-3 h-36">
            <StreamChart
              values={stream.sparkline}
              tick={tick}
              marks={marks}
              className="h-36"
              accent="rgb(82, 82, 91)"
            />
          </div>
          <div
            className={cn(
              "mt-4 transition-opacity duration-300 delay-100",
              open ? "opacity-100" : "opacity-0",
            )}
          >
            <SensorIntelCard
              sourceId={stream.source_id ?? ""}
              fieldId={stream.field_id}
              sourceFile={stream.source_file}
              note={note}
              embedded
            />
          </div>
        </div>
      </div>
    </div>
  );
}
