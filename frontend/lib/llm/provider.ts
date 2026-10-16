import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const MODEL_ID = "gpt-4.1-nano";

type Runtime = {
  noEgress: boolean;
};

const runtime: Runtime = {
  noEgress: process.env.NO_EGRESS === "true",
};

function unwrapBaseUrl(raw: string) {
  let url = raw.trim();
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.endsWith("safelinks.protection.outlook.com") &&
      parsed.searchParams.get("url")
    ) {
      url = parsed.searchParams.get("url") ?? url;
    }
  } catch {
    /* keep raw */
  }
  return url.replace(/\/+$/, "");
}

export function openaiCompatBaseURL() {
  const raw = process.env.OPENAI_BASE_URL;
  if (!raw) throw new Error("OPENAI_BASE_URL missing");
  return unwrapBaseUrl(raw).replace(/\/chat\/completions$/i, "");
}

export function openaiCompletionsURL() {
  const base = openaiCompatBaseURL();
  return `${base}/chat/completions`;
}

function assertLocal(url: string) {
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      throw new Error(`no-egress refuses non-local LLM host: ${parsed.hostname}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("no-egress")) throw err;
    throw new Error("no-egress: OPENAI_BASE_URL must be a localhost URL");
  }
}

export function getRuntime() {
  return {
    ...runtime,
    provider: "openai-compatible" as const,
    modelId: MODEL_ID,
  };
}

export function setRuntime(patch: Partial<Runtime>) {
  if (patch.noEgress !== undefined) runtime.noEgress = patch.noEgress;
}

export class LLMProvider {
  readonly modelId = MODEL_ID;
  readonly model: LanguageModel;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");
    const baseURL = openaiCompatBaseURL();
    if (getRuntime().noEgress) assertLocal(baseURL);
    this.model = createOpenAI({ apiKey, baseURL }).chat(MODEL_ID);
  }
}

export function payloadHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}
