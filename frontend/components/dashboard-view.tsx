"use client";

import { useEffect, useRef, useState } from "react";
import { StatusChip } from "@/components/status-chip";
import {
  browserGet,
  monitorStreamUrl,
  type AntibiogramResponse,
  type MonitorSnapshot,
  type RateCard,
  type WardCard,
} from "@/lib/browser-api";
import { useSimulation } from "@/components/simulation-context";
import { cn } from "@/lib/utils";

function pct(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

export function DashboardView() {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [detail, setDetail] = useState<RateCard[]>([]);
  const { resetRevision } = useSimulation();
  const key = useRef("");

  useEffect(() => {
    setSnap(null);
    setOpenCode(null);
    setDetail([]);
    key.current = "";
  }, [resetRevision]);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;

    function apply(data: MonitorSnapshot) {
      if (!on) return;
      const next = `${data.tick}:${data.as_of}:${data.wards.map((ward) => ward.n_hot).join(",")}:${data.playing}`;
      if (next === key.current) return;
      key.current = next;
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
    if (!openCode) {
      setDetail([]);
      return;
    }
    let on = true;
    void browserGet<AntibiogramResponse>(`/antibiogram?ward=${encodeURIComponent(openCode)}`)
      .then((data) => {
        if (!on) return;
        setDetail(data.rows.filter((row) => row.n_4w > 0 || row.n_year > 0));
      })
      .catch(() => {
        if (on) setDetail([]);
      });
    return () => {
      on = false;
    };
  }, [openCode, snap?.as_of]);

  const openWard = (snap?.wards ?? []).find((ward) => ward.ward_code === openCode) ?? null;

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {(snap?.wards ?? []).map((ward) => (
          <WardTile
            key={ward.ward_code}
            ward={ward}
            open={ward.ward_code === openCode}
            onToggle={() => setOpenCode((current) => (current === ward.ward_code ? null : ward.ward_code))}
          />
        ))}
      </section>

      {openWard && (
        <section className="min-h-0 overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-medium">{openWard.ward_en}</h2>
              <p className="font-mono text-xs text-muted-foreground">
                {openWard.ward_code} · {openWard.ward_type === "in" ? "inpatient" : "outpatient"} ·{" "}
                {openWard.n_hot} open on Alerts
              </p>
            </div>
            <StatusChip status={openWard.status} />
          </div>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Organism</th>
                  <th className="px-3 py-2 font-medium">Antibiotic</th>
                  <th className="px-3 py-2 font-medium">4 weeks</th>
                  <th className="px-3 py-2 font-medium">n</th>
                  <th className="px-3 py-2 font-medium">Annual</th>
                  <th className="px-3 py-2 font-medium">n</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-muted-foreground">
                      No tested isolates on this ward yet.
                    </td>
                  </tr>
                )}
                {detail.map((row) => (
                  <tr key={`${row.organism}-${row.antibiotic_code}`} className="border-t border-border">
                    <td className="px-3 py-2">{row.organism}</td>
                    <td className="px-3 py-2">
                      {row.antibiotic_code}{" "}
                      <span className="text-xs text-muted-foreground">{row.antibiotic}</span>
                    </td>
                    <td className="px-3 py-2 font-mono">{pct(row.pct_4w)}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{row.n_4w}</td>
                    <td className="px-3 py-2 font-mono">{pct(row.pct_year)}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{row.n_year}</td>
                    <td className="px-3 py-2">
                      <StatusChip status={row.level} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function WardTile({
  ward,
  open,
  onToggle,
}: {
  ward: WardCard;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "rounded-xl border bg-card p-3 text-left transition-colors",
        open ? "border-foreground/40" : "border-border hover:border-foreground/20",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm">{ward.ward_en}</p>
        <StatusChip status={ward.status} />
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {ward.ward_code} · {ward.ward_type === "in" ? "inpatient" : "outpatient"} · {ward.n_hot} open
      </p>
    </button>
  );
}
