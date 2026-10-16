"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StreamChart } from "@/components/stream-chart";
import { cn } from "@/lib/utils";
import type { RateCard } from "@/lib/browser-api";

type Origin = { left: number; top: number; width: number; height: number };

export function RateChartModal({
  row,
  origin,
  onClose,
}: {
  row: RateCard;
  origin: Origin;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const targetW = Math.min(720, vw - 32);
  const targetLeft = Math.max(16, (vw - targetW) / 2);
  const targetTop = Math.max(16, vh * 0.12);

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
    : { left: origin.left, top: origin.top, width: Math.max(origin.width, 80) };

  const four = row.pct_4w == null ? "unpublished" : `${row.pct_4w.toFixed(1)}%`;
  const annual = row.pct_year == null ? "unpublished" : `${row.pct_year.toFixed(1)}%`;

  return (
    <div className="fixed inset-0 z-[210]">
      <button
        type="button"
        aria-label="Close chart"
        className={cn(
          "absolute inset-0 bg-black/40 transition-all duration-300",
          open ? "opacity-100 backdrop-blur-md" : "opacity-0 backdrop-blur-none",
        )}
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rate-chart-title"
        className="absolute overflow-hidden rounded-xl border border-border bg-card shadow-lg transition-[left,top,width,max-height] duration-300 ease-out"
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
              <h2 id="rate-chart-title" className="truncate font-mono text-sm">
                {row.ward_code} · {row.organism} · {row.antibiotic_code}
              </h2>
              <p className="truncate text-[11px] text-muted-foreground">
                {row.antibiotic} · four weeks {four} (n={row.n_4w}) · annual {annual} (n={row.n_year})
              </p>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={close} aria-label="Close">
              <X />
            </Button>
          </div>
          <div className="mt-3 h-56">
            <StreamChart
              values={row.sparkline}
              limit={row.pct_year ?? undefined}
              className="h-56"
              accent="rgb(228, 228, 231)"
            />
          </div>
          <p className={cn("mt-3 text-xs text-muted-foreground transition-opacity duration-300", open ? "opacity-100" : "opacity-0")}>
            Each point is the four-week percent resistant, including days with fewer than 30 isolates. The table
            percentage stays blank until 30. The horizontal line is the annual rate when that rate is published.
          </p>
        </div>
      </div>
    </div>
  );
}
