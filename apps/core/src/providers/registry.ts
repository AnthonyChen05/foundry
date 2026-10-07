import { createAnthropicAdapter } from "./anthropic.js";
import { createDummyAdapter } from "./dummy.js";
import { createOpenAiCompatAdapter } from "./openai_compat.js";
import type { ProviderAdapter, ProviderRecord } from "./types.js";

export type ProviderKind = ProviderRecord["kind"];

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  openai_compat: createOpenAiCompatAdapter(),
  anthropic: createAnthropicAdapter(),
  dummy: createDummyAdapter(),
};

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  return ADAPTERS[kind];
}