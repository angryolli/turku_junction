import { LLMProvider, openaiCompatBaseURL } from "@/lib/llm/provider";

export function getModel() {
  return new LLMProvider().model;
}

export function modelMeta() {
  return {
    provider: "openai-compatible",
    model: new LLMProvider().modelId,
    baseURL: openaiCompatBaseURL(),
  };
}
