import { NextResponse } from "next/server";
import { getDecisionLog } from "@/lib/pipeline";

export async function GET() {
  const log = await getDecisionLog();
  const lines = [
    "# Process monitor report",
    "",
    `Exported ${new Date().toISOString()}`,
    "",
    "## Decision log",
    "",
    ...((log as { entries?: { ts: string; type: string; evidence_ref: string }[] })
      .entries ?? []
    ).map(
      (e) =>
        `- ${e.ts} · ${e.type} · ${e.evidence_ref}`,
    ),
  ];
  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown",
      "Content-Disposition": "attachment; filename=process-monitor-report.md",
    },
  });
}
