"use client";

import { useEffect, useState } from "react";
import { browserGet } from "@/lib/browser-api";

type Entry = {
  ts: string;
  type: string;
  evidence_ref: string;
  human_overridden: boolean;
  payload: unknown;
};

export function AuditView() {
  const [type, setType] = useState("");
  const [human, setHuman] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);

  async function refresh() {
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (human) q.set("human_overridden", "true");
    const data = await browserGet<{ entries: Entry[] }>(`/decision-log?${q}`);
    setEntries(data.entries ?? []);
  }

  useEffect(() => {
    void refresh();
  }, [type, human]);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 font-mono text-sm"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">all types</option>
          {["inference", "flag", "diagnosis", "override", "question", "model_call"].map(
            (t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ),
          )}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={human}
            onChange={(e) => setHuman(e.target.checked)}
          />
          human-overridden only
        </label>
        <a
          href="/api/audit/export"
          className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-sm"
        >
          Export report
        </a>
      </div>
      <ul className="space-y-2 font-mono text-xs">
        {entries.map((e, i) => (
          <li key={`${e.ts}-${i}`} className="rounded-md border border-border p-3">
            <p>
              {e.ts} · {e.type}
              {e.human_overridden ? " · human" : ""}
            </p>
            <p className="text-muted-foreground">{e.evidence_ref}</p>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify(e.payload)}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
