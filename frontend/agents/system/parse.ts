export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function asBool(value: unknown) {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

const ADJECTIVES = ["Excellent", "Good", "Fair", "Poor", "Untrusted"] as const;

function asAdjective(value: unknown) {
  const s = asString(value);
  const hit = ADJECTIVES.find((row) => row.toLowerCase() === s.toLowerCase());
  return hit ?? "Fair";
}

export function parseUnderstandingFields(text: string) {
  const json = extractJsonObject(text);
  const rows = Array.isArray(json?.fields) ? json.fields : [];
  const out: Record<string, import("./types").FieldUnderstanding> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const field_id = asString(item.field_id);
    if (!field_id) continue;
    const guess =
      asString(item.guess) ||
      asString(item.hypothesis) ||
      asString(item.inferred);
    const observations =
      asString(item.observations) ||
      asString(item.evidence) ||
      [asString(item.inferred), asString(item.assumed), asString(item.uncertain)]
        .filter(Boolean)
        .join(" ");
    out[field_id] = {
      field_id,
      guess,
      confidence: asNumber(item.confidence),
      observations,
      role: asString(item.role) || undefined,
    };
  }
  return out;
}

export function parseQualityFields(text: string) {
  const json = extractJsonObject(text);
  const rows = Array.isArray(json?.fields) ? json.fields : [];
  const out: Record<string, import("./types").FieldQuality> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const field_id = asString(item.field_id);
    if (!field_id) continue;
    out[field_id] = {
      field_id,
      faulty: asBool(item.faulty),
      issue: asString(item.issue) || (asBool(item.faulty) ? "faulty" : "none"),
      adjective: asAdjective(item.adjective),
      confidence: asNumber(item.confidence),
      summary: asString(item.summary),
    };
  }
  return { fields: out };
}
