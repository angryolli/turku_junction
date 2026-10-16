import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), ".data");
const LOG_FILE = path.join(LOG_DIR, "decision-log.jsonl");

export type LogEntry = {
  ts: string;
  kind: "model_call" | "tool" | "inference" | "review";
  payload: unknown;
};

async function ensureLog() {
  await mkdir(LOG_DIR, { recursive: true });
}

export async function appendLog(entry: Omit<LogEntry, "ts">) {
  await ensureLog();
  const row: LogEntry = { ts: new Date().toISOString(), ...entry };
  await appendFile(LOG_FILE, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export async function readLog(limit = 50): Promise<LogEntry[]> {
  try {
    const raw = await readFile(LOG_FILE, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry)
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}
